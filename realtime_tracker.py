#!/usr/bin/env python3
"""
Real-time Elephant Tracking Server
Processes video frames and sends live tracking data to the web frontend via WebSocket
"""

import asyncio
import json
import time
import cv2
import numpy as np
from collections import defaultdict
import websockets
import threading
from inference import get_model
import supervision as sv
from datetime import datetime
import logging
import argparse
import os
from typing import Dict, List, Set, Tuple, Optional

# Optional Twilio import (gracefully handle missing dependency)
try:
    from twilio.rest import Client as TwilioClient
except Exception:  # pragma: no cover
    TwilioClient = None  # type: ignore

# Optional .env loader
try:
    from dotenv import load_dotenv  # type: ignore
    load_dotenv()  # loads variables from a .env file in current directory if present
except Exception:
    pass

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class RealTimeElephantTracker:
    def __init__(self):
        self.ROBOFLOW_API_KEY = "e5dbeJj83VgFj9xpfGrv"
        
        # Camera configuration
        self.CAMERA_CONFIG = {
            "referencePoint": {
                "lat": -1.2921,  # Masai Mara coordinates
                "lng": 34.7617   
            },
            "scale": {
                "metersPerUnit": 10  # 1 pixel = 10 meters for realistic scale
            }
        }
        
        # Video configuration  
        # Update this path to your actual video file
        self.input_video_path = r"/Users/tarun/Downloads/Wild Elephants captured on trail camera.mp4"  # Update this path!
        
        # Initialize model and tracker
        self.model = get_model(model_id="elephant-detection-cxnt1/4", api_key=self.ROBOFLOW_API_KEY)
        self.tracker = sv.ByteTrack()
        
        # Annotators for display
        self.bounding_box_annotator = sv.BoxAnnotator()
        self.label_annotator = sv.LabelAnnotator()
        self.trace_annotator = sv.TraceAnnotator()
        
        # Data storage
        self.elephant_paths = defaultdict(list)
        self.all_tracking_data = []
        self.connected_clients = set()
        
        # Video capture
        self.cap = None
        self.fps = 30
        self.frame_width = 0
        self.frame_height = 0
        self.frame_count = 0
        self.start_time = None
        self.is_running = False
        self.headless = False

        # Boundary circles (each acts like a mesh node): [{ id, center:{lat,lng}, radius }]
        self.boundary_circles: List[Dict] = []
        # Track which circles each elephant is currently inside
        self.elephant_inside_circles: Dict[int, Set[str]] = {}
        # SMS cooldown tracker to avoid spamming: key=(elephant_id, circle_id) -> last_sent_epoch
        self._last_sms_sent: Dict[Tuple[int, str], float] = {}
        self.SMS_COOLDOWN_SECONDS = float(os.getenv("SMS_COOLDOWN_SECONDS", "120"))

        # Twilio configuration from environment
        self.TWILIO_ACCOUNT_SID = os.getenv('TWILIO_ACCOUNT_SID')
        self.TWILIO_AUTH_TOKEN = os.getenv('TWILIO_AUTH_TOKEN')
        self.TWILIO_PHONE_NUMBER = os.getenv('TWILIO_PHONE_NUMBER')
        self.TWILIO_MESSAGING_SERVICE_SID = os.getenv('TWILIO_MESSAGING_SERVICE_SID')  # optional
        # Comma-separated recipient list, e.g. "+254700000000,+254711111111"
        self.ALERT_RECIPIENTS = [x.strip() for x in os.getenv('ALERT_RECIPIENTS', '').split(',') if x.strip()]

        # Twilio client instance (if configured)
        self.twilio_client = None
        if self.TWILIO_ACCOUNT_SID and self.TWILIO_AUTH_TOKEN and self.TWILIO_PHONE_NUMBER:
            if TwilioClient is not None:
                try:
                    self.twilio_client = TwilioClient(self.TWILIO_ACCOUNT_SID, self.TWILIO_AUTH_TOKEN)
                    logger.info("Twilio client initialized for SMS alerts")
                except Exception as e:  # pragma: no cover
                    logger.warning(f"Failed to initialize Twilio client: {e}")
            else:
                logger.warning("twilio package not installed. Run: pip install twilio")
        else:
            logger.info("Twilio env vars not fully set; SMS alerts disabled (set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER)")
        
        logger.info("Real-time Elephant Tracker initialized")

    async def register_client(self, websocket):
        """Register a new WebSocket client"""
        self.connected_clients.add(websocket)
        logger.info(f"Client connected. Total clients: {len(self.connected_clients)}")
        
        # Send initial configuration
        await self.send_to_client(websocket, {
            "type": "config",
            "data": {
                "camera_config": self.CAMERA_CONFIG,
                "status": "connected"
            }
        })

    async def unregister_client(self, websocket):
        """Unregister a WebSocket client"""
        self.connected_clients.discard(websocket)
        logger.info(f"Client disconnected. Total clients: {len(self.connected_clients)}")

    async def send_to_client(self, websocket, message):
        """Send message to a specific client"""
        try:
            await websocket.send(json.dumps(message))
        except websockets.exceptions.ConnectionClosed:
            await self.unregister_client(websocket)

    async def broadcast_to_all_clients(self, message):
        """Broadcast message to all connected clients"""
        if not self.connected_clients:
            return
            
        disconnected = []
        for websocket in self.connected_clients:
            try:
                await websocket.send(json.dumps(message))
            except websockets.exceptions.ConnectionClosed:
                disconnected.append(websocket)
        
        # Remove disconnected clients
        for websocket in disconnected:
            await self.unregister_client(websocket)

    def initialize_video_capture(self):
        """Initialize video capture"""
        # Try to release any previous capture
        if self.cap is not None:
            try:
                self.cap.release()
            except Exception:
                pass

        self.cap = cv2.VideoCapture(self.input_video_path)
        
        if not self.cap.isOpened():
            logger.error(f"Error opening video: {self.input_video_path}")
            # Write an error status file so frontend knows why it's not live
            try:
                latest_path = "/Users/tarun/Desktop/Sic/HWC-one-Nighter/public/latest_detections.json"
                with open(latest_path, 'w') as f:
                    json.dump({
                        "referencePoint": self.CAMERA_CONFIG["referencePoint"],
                        "scale": self.CAMERA_CONFIG["scale"],
                        "objects": [],
                        "frame_number": 0,
                        "timestamp": int(time.time() * 1000),
                        "status": {
                            "error": f"Cannot open video: {self.input_video_path}"
                        }
                    }, f)
            except Exception as e:
                logger.warning(f"Failed to write error latest_detections.json: {e}")
            return False
            
        self.fps = self.cap.get(cv2.CAP_PROP_FPS)
        frame_width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        self.frame_width = frame_width
        self.frame_height = frame_height
        
        logger.info(f"Video loaded: {frame_width}x{frame_height}, {self.fps} FPS, {total_frames} frames")
        return True

    def _pixels_to_latlng(self, x_px: float, y_px: float) -> Tuple[float, float]:
        """Convert pixel coordinates to lat/lng using camera reference and scale.
        Uses the frame center as origin (0,0), maps pixels to meters via metersPerUnit.
        """
        rp = self.CAMERA_CONFIG["referencePoint"]
        meters_per_unit = float(self.CAMERA_CONFIG["scale"].get("metersPerUnit", 1))
        # Offset from center of frame (origin)
        cx = self.frame_width / 2.0
        cy = self.frame_height / 2.0
        x_m = (x_px - cx) * meters_per_unit
        y_m = (y_px - cy) * meters_per_unit
        # Meters to degrees
        lat_offset = y_m / 111_320.0
        lng_offset = x_m / (111_320.0 * np.cos(rp["lat"] * np.pi / 180.0))
        return (rp["lat"] + lat_offset, rp["lng"] + lng_offset)

    def _detect_circle_exits_and_alert(self, elephant_id: int, lat: float, lng: float):
        """Compute circle membership for current position and send SMS on exits."""
        if not self.boundary_circles:
            return
        prev_inside = self.elephant_inside_circles.get(elephant_id, set())
        current_inside: Set[str] = set()

        for bc in self.boundary_circles:
            cid = str(bc.get('id'))
            center = bc.get('center', {})
            radius = float(bc.get('radius', 0))
            c_lat = float(center.get('lat', 0))
            c_lng = float(center.get('lng', 0))
            d_lat_m = (lat - c_lat) * 111_320.0
            d_lng_m = (lng - c_lng) * 111_320.0 * np.cos(c_lat * np.pi / 180.0)
            dist = float(np.sqrt(d_lat_m * d_lat_m + d_lng_m * d_lng_m))
            if dist <= radius:
                current_inside.add(cid)

        # Exits and entries
        exited = [cid for cid in prev_inside if cid not in current_inside]
        entered = [cid for cid in current_inside if cid not in prev_inside]
        # Update state
        self.elephant_inside_circles[elephant_id] = current_inside

        for cid in exited:
            self._maybe_send_exit_sms(elephant_id, cid)
            try:
                logger.info(f"Elephant {elephant_id} EXITED circle {self._get_circle_label(cid)} ({cid})")
            except Exception:
                pass
        for cid in entered:
            try:
                logger.info(f"Elephant {elephant_id} ENTERED circle {self._get_circle_label(cid)} ({cid})")
            except Exception:
                pass

    def _get_circle_label(self, circle_id: str) -> str:
        """Return a human-friendly label for a circle: name if present, else id."""
        for bc in self.boundary_circles:
            try:
                if str(bc.get('id')) == str(circle_id):
                    name = bc.get('name')
                    if isinstance(name, str) and name.strip():
                        return name.strip()
                    return str(circle_id)
            except Exception:
                continue
        return str(circle_id)

    def _maybe_send_exit_sms(self, elephant_id: int, circle_id: str):
        now = time.time()
        key = (elephant_id, circle_id)
        last = self._last_sms_sent.get(key, 0)
        if now - last < self.SMS_COOLDOWN_SECONDS:
            logger.debug(f"Cooldown active for elephant {elephant_id} / circle {circle_id}; skipping SMS")
            return
        self._last_sms_sent[key] = now

        node_label = self._get_circle_label(circle_id)
        msg = f"\U0001F418 ELEPHANT ALERT from node {node_label}: Elephant {elephant_id} exited this zone. Alert ID: alert-{int(now*1000)}"
        self._broadcast_sms(msg)

    def _broadcast_sms(self, message: str):
        if not self.twilio_client:
            logger.info(f"SMS (disabled): {message}")
            return
        if not self.ALERT_RECIPIENTS:
            logger.warning("No ALERT_RECIPIENTS configured; cannot send SMS")
            return
        successes = 0
        for to in self.ALERT_RECIPIENTS:
            # Guard: Twilio error 21266 if To == From
            if self.TWILIO_PHONE_NUMBER and to.strip() == self.TWILIO_PHONE_NUMBER.strip():
                logger.warning(f"Skipping SMS: 'To' and 'From' are the same ({to}). Configure ALERT_RECIPIENTS to a different number.")
                continue
            try:
                if self.TWILIO_MESSAGING_SERVICE_SID:
                    m = self.twilio_client.messages.create(
                        body=message,
                        messaging_service_sid=self.TWILIO_MESSAGING_SERVICE_SID,
                        to=to,
                    )
                else:
                    m = self.twilio_client.messages.create(
                        body=message,
                        from_=self.TWILIO_PHONE_NUMBER,
                        to=to,
                    )
                logger.info(f"SMS sent to {to}: sid={m.sid}")
                successes += 1
            except Exception as e:  # pragma: no cover
                logger.error(f"Failed to send SMS to {to}: {e}")
        logger.info(f"SMS batch complete: {successes}/{len(self.ALERT_RECIPIENTS)} succeeded")

    async def process_video_frame(self):
        """Process a single video frame and return tracking data"""
        if not self.cap or not self.cap.isOpened():
            return None
            
        ret, frame = self.cap.read()
        if not ret:
            logger.info("End of video reached")
            return None
        
        self.frame_count += 1
        current_timestamp = int(time.time() * 1000)  # Current time in milliseconds
        
        # Run inference
        results = self.model.infer(frame)[0]
        detections = sv.Detections.from_inference(results)
        
        # Update tracker
        detections = self.tracker.update_with_detections(detections)
        
        # Create frame data
        frame_data = {
            "referencePoint": self.CAMERA_CONFIG["referencePoint"],
            "scale": self.CAMERA_CONFIG["scale"],
            "objects": [],
            "frame_number": self.frame_count,
            "timestamp": current_timestamp,
            "video_fps": self.fps
        }
        
        # Process detections
        if detections.tracker_id is not None:
            for i in range(len(detections)):
                tracker_id = detections.tracker_id[i]
                x1, y1, x2, y2 = detections.xyxy[i]
                center_x = int((x1 + x2) / 2)
                center_y = int((y1 + y2) / 2)
                confidence = float(detections.confidence[i]) if detections.confidence is not None else 0.85
                
                # Create object data
                object_data = {
                    "id": int(tracker_id),  # Use numeric ID for consistency
                    "x": center_x,
                    "y": center_y,
                    "timestamp": current_timestamp,
                    "objectType": "elephant",
                    "confidence": round(confidence, 2)
                }
                
                frame_data["objects"].append(object_data)
                
                # Update elephant paths
                self.elephant_paths[tracker_id].append({
                    'frame': self.frame_count,
                    'center': (center_x, center_y),
                    'bbox': (x1, y1, x2, y2),
                    'confidence': confidence,
                    'timestamp': current_timestamp
                })

                # If boundary circles are configured, compute current lat/lng and check exits
                if self.boundary_circles:
                    lat, lng = self._pixels_to_latlng(center_x, center_y)
                    self._detect_circle_exits_and_alert(int(tracker_id), lat, lng)
        
        # Store tracking data
        self.all_tracking_data.append(frame_data)

        # Also write latest detections JSON for the web app to poll
        try:
            latest_path = "/Users/tarun/Desktop/Sic/HWC-one-Nighter/public/latest_detections.json"
            with open(latest_path, 'w') as f:
                json.dump(frame_data, f)
        except Exception as e:
            logger.warning(f"Failed to write latest_detections.json: {e}")
        
        # Create annotated frame for display (optional)
        annotated_frame = self.bounding_box_annotator.annotate(scene=frame.copy(), detections=detections)
        annotated_frame = self.label_annotator.annotate(scene=annotated_frame, detections=detections)
        annotated_frame = self.trace_annotator.annotate(scene=annotated_frame, detections=detections)
        
        # Draw paths
        for tracker_id, path_points in self.elephant_paths.items():
            if len(path_points) > 1:
                for j in range(1, len(path_points)):
                    pt1 = path_points[j-1]['center']
                    pt2 = path_points[j]['center']
                    cv2.line(annotated_frame, pt1, pt2, (0, 255, 0), 2)
                
                if path_points:
                    current_pos = path_points[-1]['center']
                    cv2.circle(annotated_frame, current_pos, 8, (0, 0, 255), -1)
                    cv2.putText(annotated_frame, f'Elephant {tracker_id}', 
                               (current_pos[0] + 15, current_pos[1] - 15), 
                               cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        
        # Show frame (optional, skip in headless mode)
        if not self.headless:
            cv2.imshow('Live Elephant Tracking', annotated_frame)
            cv2.waitKey(1)
        
        return frame_data

    async def start_real_time_tracking(self):
        """Start the real-time tracking loop"""
        if not self.initialize_video_capture():
            return
        
        self.is_running = True
        self.start_time = time.time()
        
        logger.info("Starting real-time elephant tracking...")
        
        # Send initial data to clients
        await self.broadcast_to_all_clients({
            "type": "tracking_started",
            "data": {
                "message": "Real-time elephant tracking started",
                "config": self.CAMERA_CONFIG
            }
        })
        
        # Write a baseline latest JSON so frontend can switch from "connecting"
        try:
            latest_path = "/Users/tarun/Desktop/Sic/HWC-one-Nighter/public/latest_detections.json"
            with open(latest_path, 'w') as f:
                json.dump({
                    "referencePoint": self.CAMERA_CONFIG["referencePoint"],
                    "scale": self.CAMERA_CONFIG["scale"],
                    "objects": [],
                    "frame_number": 0,
                    "timestamp": int(time.time() * 1000)
                }, f)
        except Exception as e:
            logger.warning(f"Failed to write baseline latest_detections.json: {e}")

        frame_interval = 1.0 / 2.0  # Process ~2 frames per second for real-time feel
        
        while self.is_running:
            try:
                frame_data = await self.process_video_frame()
                
                if frame_data is None:
                    # End of video
                    await self.broadcast_to_all_clients({
                        "type": "tracking_complete",
                        "data": {
                            "message": "Video tracking complete",
                            "total_frames": self.frame_count,
                            "total_elephants": len(self.elephant_paths)
                        }
                    })
                    break
                
                # Send real-time update to all clients
                await self.broadcast_to_all_clients({
                    "type": "live_tracking_update",
                    "data": frame_data
                })
                
                # Log progress
                if self.frame_count % 30 == 0:
                    logger.info(f"Frame {self.frame_count}: {len(frame_data['objects'])} elephants detected")
                
                # Control frame rate
                await asyncio.sleep(frame_interval)
                
            except Exception as e:
                logger.error(f"Error processing frame {self.frame_count}: {e}")
                await asyncio.sleep(1)
        
        # Cleanup
        if self.cap:
            self.cap.release()
        cv2.destroyAllWindows()
        
        logger.info("Real-time tracking stopped")

    async def handle_client_message(self, websocket, message):
        """Handle messages from clients"""
        try:
            data = json.loads(message)
            command = data.get('command')
            
            if command == 'start_tracking':
                # Optional video_path in payload
                video_path = data.get('video_path')
                if video_path:
                    self.input_video_path = video_path
                    logger.info(f"Video path set via WS: {self.input_video_path}")
                if not self.is_running:
                    # Start tracking in background task
                    asyncio.create_task(self.start_real_time_tracking())
                    await self.send_to_client(websocket, {
                        "type": "command_response",
                        "data": {"status": "tracking_started", "video": self.input_video_path}
                    })
                else:
                    await self.send_to_client(websocket, {
                        "type": "command_response",
                        "data": {"status": "already_running", "video": self.input_video_path}
                    })
                
            elif command == 'stop_tracking':
                self.is_running = False
                await self.send_to_client(websocket, {
                    "type": "command_response", 
                    "data": {"status": "tracking_stopped"}
                })
            elif command == 'set_config':
                # Allow updating referencePoint and/or scale at runtime
                cfg = data.get('config', {})
                rp = cfg.get('referencePoint')
                sc = cfg.get('scale')
                bcircles = cfg.get('boundaryCircles')
                if isinstance(rp, dict) and 'lat' in rp and 'lng' in rp:
                    self.CAMERA_CONFIG['referencePoint'] = { 'lat': float(rp['lat']), 'lng': float(rp['lng']) }
                if isinstance(sc, dict) and 'metersPerUnit' in sc:
                    self.CAMERA_CONFIG['scale'] = { 'metersPerUnit': float(sc['metersPerUnit']) }
                # Optional: set/update boundary circles (list of { id, center:{lat,lng}, radius })
                if isinstance(bcircles, list):
                    safe_list = []
                    for bc in bcircles:
                        try:
                            cid = str(bc.get('id'))
                            c = bc.get('center', {})
                            lat = float(c.get('lat'))
                            lng = float(c.get('lng'))
                            r = float(bc.get('radius'))
                            name = bc.get('name') if isinstance(bc.get('name'), str) else None
                            safe_list.append({ 'id': cid, 'name': name, 'center': { 'lat': lat, 'lng': lng }, 'radius': r })
                        except Exception:
                            continue
                    self.boundary_circles = safe_list
                    # Reset inside-tracking for fresh evaluation
                    self.elephant_inside_circles = {}
                    try:
                        summary = ", ".join([f"{b.get('id')}\u2192{(b.get('name') or '').strip() or b.get('id')}" for b in safe_list])
                        logger.info(f"Updated boundary circles: {summary}")
                    except Exception:
                        pass
                await self.send_to_client(websocket, {
                    "type": "command_response",
                    "data": {
                        "status": "config_updated",
                        "config": self.CAMERA_CONFIG,
                        "boundaryCircles": self.boundary_circles
                    }
                })
                
            elif command == 'send_test_exit':
                # Force an SMS for a given circle to validate pipeline
                circle_id = str(data.get('circle_id') or '')
                elephant_id = int(data.get('elephant_id') or 1)
                ignore_cooldown = bool(data.get('ignoreCooldown') or False)
                if ignore_cooldown:
                    # reset cooldown so it will send now
                    try:
                        self._last_sms_sent.pop((elephant_id, circle_id), None)
                    except Exception:
                        pass
                if circle_id:
                    self._maybe_send_exit_sms(elephant_id, circle_id)
                    await self.send_to_client(websocket, {
                        "type": "command_response",
                        "data": {"status": "test_exit_sent", "circle_id": circle_id, "elephant_id": elephant_id}
                    })
                else:
                    await self.send_to_client(websocket, {
                        "type": "command_response",
                        "data": {"status": "error", "error": "circle_id required"}
                    })

            elif command == 'send_sms':
                # Send an arbitrary SMS message (from UI alerts)
                msg = data.get('message')
                if isinstance(msg, str) and msg.strip():
                    self._broadcast_sms(msg.strip())
                    await self.send_to_client(websocket, {
                        "type": "command_response",
                        "data": {"status": "sms_sent", "length": len(msg.strip())}
                    })
                else:
                    await self.send_to_client(websocket, {
                        "type": "command_response",
                        "data": {"status": "error", "error": "message required"}
                    })

            elif command == 'get_status':
                await self.send_to_client(websocket, {
                    "type": "status",
                    "data": {
                        "is_running": self.is_running,
                        "frame_count": self.frame_count,
                        "elephants_tracked": len(self.elephant_paths),
                        "connected_clients": len(self.connected_clients)
                    }
                })
                
        except Exception as e:
            logger.error(f"Error handling client message: {e}")

    async def websocket_handler(self, websocket):
        """Handle WebSocket connections"""
        await self.register_client(websocket)
        try:
            async for message in websocket:
                await self.handle_client_message(websocket, message)
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            await self.unregister_client(websocket)

# Global tracker instance
tracker = RealTimeElephantTracker()

async def handle_client(websocket):
    """Global websocket handler function"""
    await tracker.websocket_handler(websocket)

async def main():
    """Start the WebSocket server"""
    parser = argparse.ArgumentParser(description='Real-time Elephant Tracking WebSocket Server')
    parser.add_argument('--video', type=str, help='Path to the input video file')
    parser.add_argument('--host', type=str, default='localhost', help='WebSocket host (default: localhost)')
    parser.add_argument('--port', type=int, default=8765, help='WebSocket port (default: 8765)')
    parser.add_argument('--autostart', action='store_true', help='Automatically start tracking on launch')
    parser.add_argument('--headless', action='store_true', help='Disable OpenCV window (no GUI)')
    parser.add_argument('--test-sms', action='store_true', help='Send a test SMS to ALERT_RECIPIENTS and exit')
    parser.add_argument('--boundary-center', type=str, help='Single boundary center as "lat,lng" (e.g., -1.2921,34.7617)')
    parser.add_argument('--boundary-radius', type=float, help='Single boundary radius in meters (e.g., 500)')
    parser.add_argument('--circles', type=str, help='Path to JSON file with boundaryCircles list: [{ id, center:{lat,lng}, radius }]')
    args = parser.parse_args()

    if args.video:
        tracker.input_video_path = args.video
        logger.info(f"CLI video path set: {tracker.input_video_path}")
    if args.headless:
        tracker.headless = True
        logger.info("Headless mode enabled (no OpenCV window)")

    logger.info("Starting Real-time Elephant Tracking WebSocket Server...")
    logger.info(f"Server will be available at ws://{args.host}:{args.port}")
    logger.info("🐘 Real-time Elephant Tracking Server running!")
    logger.info(f"📡 WebSocket server: ws://{args.host}:{args.port}")
    logger.info("🎥 Ready to process video and send live updates")
    
    if args.test_sms:
        tracker._broadcast_sms("✅ Test SMS from RealTimeElephantTracker")
        return

    # Initialize boundary circles from CLI/env for automatic SMS alerts
    # Priority: --circles JSON > --boundary-* CLI > ENV > none
    initialized_circles = False
    if args.circles:
        try:
            with open(args.circles, 'r') as f:
                data = json.load(f)
            if isinstance(data, list):
                safe_list = []
                for bc in data:
                    try:
                        cid = str(bc.get('id'))
                        c = bc.get('center', {})
                        lat = float(c.get('lat'))
                        lng = float(c.get('lng'))
                        r = float(bc.get('radius'))
                        safe_list.append({ 'id': cid, 'center': { 'lat': lat, 'lng': lng }, 'radius': r })
                    except Exception:
                        continue
                tracker.boundary_circles = safe_list
                initialized_circles = True
                logger.info(f"Loaded {len(safe_list)} boundary circles from {args.circles}")
        except Exception as e:
            logger.error(f"Failed to load circles from {args.circles}: {e}")

    if not initialized_circles and args.boundary_center and args.boundary_radius:
        try:
            lat_str, lng_str = [x.strip() for x in args.boundary_center.split(',')]
            lat = float(lat_str)
            lng = float(lng_str)
            tracker.boundary_circles = [{ 'id': 'home', 'center': { 'lat': lat, 'lng': lng }, 'radius': float(args.boundary_radius) }]
            initialized_circles = True
            logger.info(f"Using single boundary circle at ({lat},{lng}) radius {args.boundary_radius}m")
        except Exception as e:
            logger.error(f"Invalid --boundary-center format. Expected 'lat,lng'. Error: {e}")

    if not initialized_circles:
        # Try ENV-based single boundary
        env_lat = os.getenv('BOUNDARY_CENTER_LAT')
        env_lng = os.getenv('BOUNDARY_CENTER_LNG')
        env_r = os.getenv('BOUNDARY_RADIUS_M')
        if env_lat and env_lng and env_r:
            try:
                tracker.boundary_circles = [{
                    'id': 'home',
                    'center': { 'lat': float(env_lat), 'lng': float(env_lng) },
                    'radius': float(env_r)
                }]
                initialized_circles = True
                logger.info(f"Using ENV boundary circle at ({env_lat},{env_lng}) radius {env_r}m")
            except Exception as e:
                logger.error(f"Invalid ENV boundary values: {e}")

    if initialized_circles:
        # Reset inside tracking to start fresh
        tracker.elephant_inside_circles = {}
        logger.info(f"Boundary circles active ({len(tracker.boundary_circles)}). SMS alerts on exit enabled.")
    
    async with websockets.serve(handle_client, args.host, args.port):
        logger.info("Server started successfully!")
        # Autostart tracking if requested or if a video path was provided
        if args.autostart or args.video:
            logger.info("Autostarting tracking loop...")
            asyncio.create_task(tracker.start_real_time_tracking())
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")