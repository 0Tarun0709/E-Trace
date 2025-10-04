#!/usr/bin/env python3
"""
Real Video Tracker - Processes actual video file for real-time tracking
Uses OpenCV to read video frames and simulates object detection
Compatible with websockets 15.x
"""

import asyncio
import json
import time
import websockets
import logging
import cv2
import numpy as np
from collections import defaultdict
import os

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global state
connected_clients = set()
is_running = False
frame_count = 0
cap = None
video_fps = 30
total_frames = 0

# Video configuration
VIDEO_PATH = r"/Users/tarun/Downloads/Wild Elephants captured on trail camera.mp4"

CAMERA_CONFIG = {
    "referencePoint": {"lat": -1.2921, "lng": 34.7617},
    "scale": {"metersPerUnit": 10}
}

# Simple object detection simulation (instead of AI)
object_tracker = {}
next_object_id = 1

def simple_motion_detection(frame, prev_frame):
    """
    Simple motion detection to simulate object tracking
    Returns detected moving objects as bounding boxes
    """
    global next_object_id
    
    if prev_frame is None:
        return []
    
    # Convert to grayscale
    gray1 = cv2.cvtColor(prev_frame, cv2.COLOR_BGR2GRAY)
    gray2 = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    
    # Calculate difference
    diff = cv2.absdiff(gray1, gray2)
    
    # Threshold to get binary image
    _, thresh = cv2.threshold(diff, 30, 255, cv2.THRESH_BINARY)
    
    # Find contours
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    detections = []
    
    # Filter contours by area (simulate object detection)
    for contour in contours:
        area = cv2.contourArea(contour)
        if area > 500:  # Minimum area threshold
            x, y, w, h = cv2.boundingRect(contour)
            
            # Calculate center
            center_x = x + w // 2
            center_y = y + h // 2
            
            # Simple tracking - assign ID based on proximity to previous objects
            object_id = next_object_id
            
            # Check if this detection is close to existing tracked objects
            min_distance = float('inf')
            closest_id = None
            
            for tracked_id, last_pos in object_tracker.items():
                distance = np.sqrt((center_x - last_pos[0])**2 + (center_y - last_pos[1])**2)
                if distance < min_distance and distance < 100:  # 100 pixel threshold
                    min_distance = distance
                    closest_id = tracked_id
            
            if closest_id:
                object_id = closest_id
            else:
                next_object_id += 1
            
            # Update tracker
            object_tracker[object_id] = (center_x, center_y)
            
            detections.append({
                'id': object_id,
                'x': center_x,
                'y': center_y,
                'bbox': (x, y, w, h),
                'area': area
            })
    
    return detections

async def register_client(websocket):
    """Register a new WebSocket client"""
    connected_clients.add(websocket)
    logger.info(f"Client connected. Total clients: {len(connected_clients)}")
    
    # Send initial configuration
    await send_to_client(websocket, {
        "type": "config",
        "data": {
            "camera_config": CAMERA_CONFIG,
            "status": "connected"
        }
    })

async def unregister_client(websocket):
    """Unregister a WebSocket client"""
    connected_clients.discard(websocket)
    logger.info(f"Client disconnected. Total clients: {len(connected_clients)}")

async def send_to_client(websocket, message):
    """Send message to a specific client"""
    try:
        await websocket.send(json.dumps(message))
    except websockets.exceptions.ConnectionClosed:
        await unregister_client(websocket)

async def broadcast_to_all_clients(message):
    """Broadcast message to all connected clients"""
    if not connected_clients:
        return
        
    disconnected = []
    for websocket in connected_clients:
        try:
            await websocket.send(json.dumps(message))
        except websockets.exceptions.ConnectionClosed:
            disconnected.append(websocket)
    
    # Remove disconnected clients
    for websocket in disconnected:
        await unregister_client(websocket)

def initialize_video():
    """Initialize video capture"""
    global cap, video_fps, total_frames
    
    if not os.path.exists(VIDEO_PATH):
        logger.error(f"Video file not found: {VIDEO_PATH}")
        return False
    
    cap = cv2.VideoCapture(VIDEO_PATH)
    
    if not cap.isOpened():
        logger.error(f"Error opening video: {VIDEO_PATH}")
        return False
    
    video_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    
    logger.info(f"Video loaded successfully:")
    logger.info(f"  Path: {VIDEO_PATH}")
    logger.info(f"  Resolution: {frame_width}x{frame_height}")
    logger.info(f"  FPS: {video_fps}")
    logger.info(f"  Total frames: {total_frames}")
    
    return True

async def process_video_frames():
    """Process video frames and detect objects"""
    global frame_count, cap, is_running
    
    if not initialize_video():
        return
    
    logger.info("Starting real video processing...")
    
    # Send initial data to clients
    await broadcast_to_all_clients({
        "type": "tracking_started",
        "data": {
            "message": "Real video tracking started",
            "config": CAMERA_CONFIG,
            "video_info": {
                "fps": video_fps,
                "total_frames": total_frames,
                "path": os.path.basename(VIDEO_PATH)
            }
        }
    })
    
    prev_frame = None
    frame_interval = 1.0 / 3.0  # Process 3 FPS for real-time feel
    
    while is_running and connected_clients:
        try:
            ret, frame = cap.read()
            
            if not ret:
                logger.info("End of video reached")
                await broadcast_to_all_clients({
                    "type": "tracking_complete",
                    "data": {
                        "message": "Video processing complete",
                        "total_frames_processed": frame_count,
                        "video_file": os.path.basename(VIDEO_PATH)
                    }
                })
                break
            
            frame_count += 1
            current_timestamp = int(time.time() * 1000)
            
            # Detect objects using simple motion detection
            detections = simple_motion_detection(frame, prev_frame)
            
            # Create frame data
            frame_data = {
                "referencePoint": CAMERA_CONFIG["referencePoint"],
                "scale": CAMERA_CONFIG["scale"],
                "objects": [],
                "frame_number": frame_count,
                "timestamp": current_timestamp,
                "video_fps": video_fps,
                "total_frames": total_frames
            }
            
            # Convert detections to objects
            for detection in detections:
                object_data = {
                    "id": detection['id'],
                    "x": detection['x'],
                    "y": detection['y'],
                    "timestamp": current_timestamp,
                    "objectType": "moving_object",  # Could be elephant or any moving object
                    "confidence": 0.85,  # Simulated confidence
                    "area": detection['area']
                }
                frame_data["objects"].append(object_data)
            
            # Send real-time update to all clients
            await broadcast_to_all_clients({
                "type": "live_tracking_update", 
                "data": frame_data
            })
            
            # Log progress
            if frame_count % 30 == 0:
                progress = (frame_count / total_frames) * 100
                logger.info(f"Frame {frame_count}/{total_frames} ({progress:.1f}%): {len(detections)} objects detected")
            
            # Store current frame for next iteration
            prev_frame = frame.copy()
            
            # Control frame rate
            await asyncio.sleep(frame_interval)
            
        except Exception as e:
            logger.error(f"Error processing frame {frame_count}: {e}")
            await asyncio.sleep(1)
    
    # Cleanup
    if cap:
        cap.release()
    
    logger.info(f"Video processing stopped. Processed {frame_count} frames.")
    is_running = False

async def handle_client_message(websocket, message):
    """Handle messages from clients"""
    global is_running
    
    try:
        data = json.loads(message)
        command = data.get('command')
        
        if command == 'start_tracking':
            if not is_running:
                is_running = True
                # Start video processing in background task
                asyncio.create_task(process_video_frames())
                await send_to_client(websocket, {
                    "type": "command_response",
                    "data": {"status": "video_tracking_started"}
                })
            else:
                await send_to_client(websocket, {
                    "type": "command_response",
                    "data": {"status": "already_running"}
                })
            
        elif command == 'stop_tracking':
            is_running = False
            if cap:
                cap.release()
            await send_to_client(websocket, {
                "type": "command_response", 
                "data": {"status": "tracking_stopped"}
            })
            
        elif command == 'get_status':
            await send_to_client(websocket, {
                "type": "status",
                "data": {
                    "is_running": is_running,
                    "frame_count": frame_count,
                    "total_frames": total_frames,
                    "video_path": VIDEO_PATH,
                    "connected_clients": len(connected_clients)
                }
            })
            
    except Exception as e:
        logger.error(f"Error handling client message: {e}")

async def handle_client(websocket):
    """Handle WebSocket client connection"""
    await register_client(websocket)
    try:
        async for message in websocket:
            await handle_client_message(websocket, message)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        await unregister_client(websocket)

async def main():
    """Start the WebSocket server"""
    logger.info("Starting Real Video Tracking Server...")
    logger.info("🎥 Real-time Video Processing System")
    logger.info(f"📹 Video file: {VIDEO_PATH}")
    logger.info("📡 WebSocket server: ws://localhost:8765") 
    logger.info("🎮 Ready for real video tracking")
    logger.info("🌐 Open http://localhost:5174 and click 'Connect to Server' -> 'Start Live'")
    
    # Check video file exists
    if not os.path.exists(VIDEO_PATH):
        logger.error(f"❌ Video file not found: {VIDEO_PATH}")
        logger.error("Please update the VIDEO_PATH in the script to point to your video file")
        return
    
    # Start WebSocket server
    async with websockets.serve(handle_client, "localhost", 8765):
        logger.info("✅ Server started successfully!")
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")
        if cap:
            cap.release()
        cv2.destroyAllWindows()