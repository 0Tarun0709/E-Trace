#!/usr/bin/env python3
"""
Real Elephant Data Tracker - Uses actual elephant tracking data for real-time streaming
Processes the corrected_tracking_data.json file frame by frame in real-time
Compatible with websockets 15.x
"""

import asyncio
import json
import time
import websockets
import logging
import os
import math

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global state
connected_clients = set()
is_running = False
frame_count = 0
tracking_data = None
total_frames = 0

# Data file configuration
DATA_PATH = r"/Users/tarun/Desktop/Sic/HWC-one-Nighter/corrected_tracking_data.json"

CAMERA_CONFIG = {
    "referencePoint": {"lat": -1.2921, "lng": 34.7617},  # Masai Mara coordinates
    "scale": {"metersPerUnit": 1}  # 1 unit = 1 meter
}

# Boundary configuration (square boundary in local coordinates)
BOUNDARY_CONFIG = {
    "enabled": True,
    "type": "square",
    "center": {"x": 200, "y": 250},  # Center of the boundary in local coordinates
    "size": 100,  # Square size (100x100 meters) - appropriate for detailed tracking
    "alert_zone_name": "Restricted Area"
}

# Track elephants in boundary
elephants_in_boundary = set()
boundary_alerts = []

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

def is_in_boundary(x, y):
    """Check if coordinates are within the boundary"""
    if not BOUNDARY_CONFIG["enabled"]:
        return False
    
    center_x = BOUNDARY_CONFIG["center"]["x"]
    center_y = BOUNDARY_CONFIG["center"]["y"]
    half_size = BOUNDARY_CONFIG["size"] / 2
    
    # Check if point is within square boundary
    return (center_x - half_size <= x <= center_x + half_size and 
            center_y - half_size <= y <= center_y + half_size)

def convert_boundary_to_latlng():
    """Convert boundary coordinates to lat/lng for map display"""
    center_x = BOUNDARY_CONFIG["center"]["x"]
    center_y = BOUNDARY_CONFIG["center"]["y"]
    half_size = BOUNDARY_CONFIG["size"] / 2
    
    # Convert corner points to lat/lng
    corners = [
        (center_x - half_size, center_y - half_size),  # Bottom-left
        (center_x + half_size, center_y - half_size),  # Bottom-right
        (center_x + half_size, center_y + half_size),  # Top-right
        (center_x - half_size, center_y + half_size),  # Top-left
    ]
    
    boundary_latlng = []
    for x, y in corners:
        # Convert local coordinates to lat/lng using same formula as in map
        x_meters = x * CAMERA_CONFIG["scale"]["metersPerUnit"]
        y_meters = y * CAMERA_CONFIG["scale"]["metersPerUnit"]
        
        lat_offset = y_meters / 111320
        lng_offset = x_meters / (111320 * math.cos(CAMERA_CONFIG["referencePoint"]["lat"] * math.pi / 180))
        
        lat = CAMERA_CONFIG["referencePoint"]["lat"] + lat_offset
        lng = CAMERA_CONFIG["referencePoint"]["lng"] + lng_offset
        
        boundary_latlng.append([lat, lng])
    
    return boundary_latlng

def load_tracking_data():
    """Load the complete tracking data from JSON file"""
    global tracking_data, total_frames
    
    if not os.path.exists(DATA_PATH):
        logger.error(f"Tracking data file not found: {DATA_PATH}")
        return False
    
    try:
        logger.info(f"Loading elephant tracking data from: {DATA_PATH}")
        
        with open(DATA_PATH, 'r') as f:
            tracking_data = json.load(f)
        
        total_frames = tracking_data.get('metadata', {}).get('total_frames', len(tracking_data.get('frames', [])))
        fps = tracking_data.get('metadata', {}).get('fps', 30.0)
        duration = tracking_data.get('metadata', {}).get('video_duration', 0)
        
        logger.info(f"✅ Tracking data loaded successfully:")
        logger.info(f"  Total frames: {total_frames}")
        logger.info(f"  Original FPS: {fps}")
        logger.info(f"  Duration: {duration:.2f} seconds")
        logger.info(f"  File size: {os.path.getsize(DATA_PATH) / 1024:.1f} KB")
        
        return True
        
    except Exception as e:
        logger.error(f"Error loading tracking data: {e}")
        return False

async def process_tracking_frames():
    """Process tracking data frames in real-time"""
    global frame_count, is_running
    
    if not load_tracking_data():
        return
    
    frame_count = 0
    logger.info("Starting real elephant data streaming...")
    
    # Send initial complete dataset to clients
    complete_dataset = {
        "metadata": tracking_data.get('metadata', {}),
        "frames": tracking_data.get('frames', [])
    }
    
    await broadcast_to_all_clients({
        "type": "tracking_data_loaded",
        "data": complete_dataset,
        "boundary": {
            "enabled": BOUNDARY_CONFIG["enabled"],
            "coordinates": convert_boundary_to_latlng(),
            "name": BOUNDARY_CONFIG["alert_zone_name"]
        }
    })
    
    frame_interval = 0.2  # 5 FPS for smooth real-time visualization
    frames = tracking_data.get('frames', [])
    
    while is_running and connected_clients and frame_count < len(frames):
        try:
            current_frame_data = frames[frame_count]
            frame_count += 1
            current_timestamp = int(time.time() * 1000)
            
            # Convert frame data to our format
            frame_data = {
                "referencePoint": CAMERA_CONFIG["referencePoint"],
                "scale": CAMERA_CONFIG["scale"],
                "objects": [],
                "frame_number": frame_count,
                "timestamp": current_timestamp,
                "video_fps": 5.0,  # Our streaming rate
                "total_frames": total_frames,
                "source": "real_elephant_data"
            }
            
            # Extract objects from current frame and check boundary violations
            boundary_violations = []
            if 'objects' in current_frame_data:
                for obj in current_frame_data['objects']:
                    elephant_id = str(obj.get('id', 'elephant_1'))  # Ensure string ID
                    x = obj.get('x', 0)
                    y = obj.get('y', 0)
                    
                    # Check if elephant is in boundary
                    in_boundary = is_in_boundary(x, y)
                    was_in_boundary = elephant_id in elephants_in_boundary
                    
                    # Detect boundary entry (crossing into restricted area)
                    if in_boundary and not was_in_boundary:
                        elephants_in_boundary.add(elephant_id)
                        alert_message = f"🚨 ALERT: Elephant {elephant_id} entered restricted area!"
                        boundary_violations.append({
                            "elephant_id": elephant_id,
                            "event": "entry",
                            "message": alert_message,
                            "coordinates": {"x": x, "y": y},
                            "timestamp": current_timestamp
                        })
                        logger.warning(alert_message)
                    
                    # Detect boundary exit
                    elif not in_boundary and was_in_boundary:
                        elephants_in_boundary.discard(elephant_id)
                        logger.info(f"✅ Elephant {elephant_id} exited restricted area")
                    
                    # Convert to our object format with alert status
                    object_data = {
                        "id": elephant_id,
                        "x": x,
                        "y": y, 
                        "timestamp": current_timestamp,
                        "objectType": "elephant",  # Real elephants!
                        "confidence": obj.get('confidence', 0.95),
                        "frame_source": frame_count,
                        "in_boundary": in_boundary,
                        "alert_status": "violation" if in_boundary else "normal"
                    }
                    frame_data["objects"].append(object_data)
            
            # Add boundary violation info to frame data
            frame_data["boundary_violations"] = boundary_violations
            frame_data["elephants_in_boundary"] = list(elephants_in_boundary)
            
            # Send real-time animation update to all clients
            await broadcast_to_all_clients({
                "type": "animation_frame_update", 
                "frame_index": frame_count - 1,  # 0-based index
                "elephants_in_boundary": list(elephants_in_boundary),
                "data": frame_data
            })
            
            # Send separate alert messages for boundary violations
            for violation in boundary_violations:
                await broadcast_to_all_clients({
                    "type": "boundary_alert",
                    "data": violation
                })
            
            # Log progress every 50 frames
            if frame_count % 50 == 0:
                progress = (frame_count / total_frames) * 100
                objects_in_frame = len(frame_data["objects"])
                logger.info(f"Frame {frame_count}/{total_frames} ({progress:.1f}%): {objects_in_frame} elephants")
            
            # Control frame rate
            await asyncio.sleep(frame_interval)
            
        except Exception as e:
            logger.error(f"Error processing frame {frame_count}: {e}")
            await asyncio.sleep(1)
    
    # Send completion message
    if frame_count >= len(frames):
        await broadcast_to_all_clients({
            "type": "tracking_complete",
            "data": {
                "message": "Real elephant data streaming complete",
                "total_frames_processed": frame_count,
                "source": "corrected_tracking_data.json"
            }
        })
    
    logger.info(f"Elephant data streaming stopped. Processed {frame_count} frames.")
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
                # Start data processing in background task
                asyncio.create_task(process_tracking_frames())
                await send_to_client(websocket, {
                    "type": "command_response",
                    "data": {"status": "real_elephant_tracking_started"}
                })
            else:
                await send_to_client(websocket, {
                    "type": "command_response",
                    "data": {"status": "already_running"}
                })
            
        elif command == 'stop_tracking':
            is_running = False
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
                    "data_source": "real_elephant_data",
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
    logger.info("Starting Real Elephant Data Streaming Server...")
    logger.info("🐘 Real Elephant Tracking Data System")
    logger.info(f"📊 Data source: {DATA_PATH}")
    logger.info("📡 WebSocket server: ws://localhost:8765") 
    logger.info("🎮 Ready to stream real elephant movement data")
    logger.info("🌐 Open http://localhost:5174 and click 'Connect to Server' -> 'Start Live'")
    
    # Check data file exists
    if not os.path.exists(DATA_PATH):
        logger.error(f"❌ Tracking data file not found: {DATA_PATH}")
        logger.error("Please ensure the corrected_tracking_data.json file exists")
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