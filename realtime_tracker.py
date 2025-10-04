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
        self.input_video_path = r"/Users/tarun/Desktop/Sic/HWC-Hackathon/assets/ScreenRec-4.mov"  # Update this path!
        
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
        self.frame_count = 0
        self.start_time = None
        self.is_running = False
        
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
        self.cap = cv2.VideoCapture(self.input_video_path)
        
        if not self.cap.isOpened():
            logger.error(f"Error opening video: {self.input_video_path}")
            return False
            
        self.fps = self.cap.get(cv2.CAP_PROP_FPS)
        frame_width = int(self.cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        frame_height = int(self.cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        total_frames = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))
        
        logger.info(f"Video loaded: {frame_width}x{frame_height}, {self.fps} FPS, {total_frames} frames")
        return True

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
        
        # Store tracking data
        self.all_tracking_data.append(frame_data)
        
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
        
        # Show frame (optional, comment out for headless operation)
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
        
        frame_interval = 1.0 / 2.0  # Process 2 frames per second for real-time feel
        
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
                if not self.is_running:
                    # Start tracking in background task
                    asyncio.create_task(self.start_real_time_tracking())
                await self.send_to_client(websocket, {
                    "type": "command_response",
                    "data": {"status": "tracking_started" if not self.is_running else "already_running"}
                })
                
            elif command == 'stop_tracking':
                self.is_running = False
                await self.send_to_client(websocket, {
                    "type": "command_response", 
                    "data": {"status": "tracking_stopped"}
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
    logger.info("Starting Real-time Elephant Tracking WebSocket Server...")
    logger.info("Server will be available at ws://localhost:8765")
    
    # Start WebSocket server - newer websockets library syntax
    logger.info("🐘 Real-time Elephant Tracking Server running!")
    logger.info("📡 WebSocket server: ws://localhost:8765")
    logger.info("🎥 Ready to process video and send live updates")
    
    async with websockets.serve(handle_client, "localhost", 8765):
        logger.info("Server started successfully!")
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")