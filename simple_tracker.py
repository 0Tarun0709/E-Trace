#!/usr/bin/env python3
"""
Simple WebSocket Test Server for Real-time Elephant Tracking
Compatible with websockets 15.x
"""

import asyncio
import json
import time
import websockets
import logging
import random
import math

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global state
connected_clients = set()
is_running = False
frame_count = 0
elephant_positions = {}

CAMERA_CONFIG = {
    "referencePoint": {"lat": -1.2921, "lng": 34.7617},
    "scale": {"metersPerUnit": 10}
}

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

def generate_mock_elephant_data():
    """Generate mock elephant tracking data for testing"""
    global frame_count, elephant_positions
    
    current_timestamp = int(time.time() * 1000)
    
    # Create frame data
    frame_data = {
        "referencePoint": CAMERA_CONFIG["referencePoint"],
        "scale": CAMERA_CONFIG["scale"],
        "objects": [],
        "frame_number": frame_count,
        "timestamp": current_timestamp,
        "video_fps": 30
    }
    
    # Simulate 1-3 elephants moving in realistic patterns
    num_elephants = random.randint(1, 3)
    
    for elephant_id in range(1, num_elephants + 1):
        if elephant_id not in elephant_positions:
            # Initialize new elephant at random position
            elephant_positions[elephant_id] = {
                'x': random.randint(50, 300),
                'y': random.randint(50, 200),
                'direction': random.uniform(0, 2 * math.pi),
                'speed': random.uniform(1, 3)
            }
        
        # Update elephant position (simple wandering behavior)
        elephant = elephant_positions[elephant_id]
        
        # Slightly change direction occasionally
        if random.random() < 0.1:
            elephant['direction'] += random.uniform(-0.5, 0.5)
        
        # Move elephant
        elephant['x'] += elephant['speed'] * math.cos(elephant['direction'])
        elephant['y'] += elephant['speed'] * math.sin(elephant['direction'])
        
        # Keep within bounds (bounce off edges)
        if elephant['x'] < 10 or elephant['x'] > 400:
            elephant['direction'] = math.pi - elephant['direction']
            elephant['x'] = max(10, min(400, elephant['x']))
        
        if elephant['y'] < 10 or elephant['y'] > 300:
            elephant['direction'] = -elephant['direction']  
            elephant['y'] = max(10, min(300, elephant['y']))
        
        # Create object data
        object_data = {
            "id": elephant_id,
            "x": int(elephant['x']),
            "y": int(elephant['y']),
            "timestamp": current_timestamp,
            "objectType": "elephant",
            "confidence": round(random.uniform(0.7, 0.95), 2)
        }
        
        frame_data["objects"].append(object_data)
    
    return frame_data

async def start_mock_tracking():
    """Start the mock tracking simulation"""
    global is_running, frame_count
    
    is_running = True
    frame_count = 0
    
    logger.info("Starting mock elephant tracking simulation...")
    
    # Send initial data to clients
    await broadcast_to_all_clients({
        "type": "tracking_started",
        "data": {
            "message": "Mock elephant tracking started",
            "config": CAMERA_CONFIG
        }
    })
    
    frame_interval = 0.5  # 2 FPS for demo
    
    while is_running and connected_clients:
        try:
            frame_count += 1
            frame_data = generate_mock_elephant_data()
            
            # Send real-time update to all clients
            await broadcast_to_all_clients({
                "type": "live_tracking_update", 
                "data": frame_data
            })
            
            # Log progress
            if frame_count % 10 == 0:
                logger.info(f"Frame {frame_count}: {len(frame_data['objects'])} elephants detected")
            
            # Control frame rate
            await asyncio.sleep(frame_interval)
            
            # Stop after 200 frames (demo limit)
            if frame_count >= 200:
                await broadcast_to_all_clients({
                    "type": "tracking_complete",
                    "data": {
                        "message": "Demo tracking complete",
                        "total_frames": frame_count,
                        "total_elephants": len(elephant_positions)
                    }
                })
                break
            
        except Exception as e:
            logger.error(f"Error processing frame {frame_count}: {e}")
            await asyncio.sleep(1)
    
    logger.info("Mock tracking stopped")
    is_running = False

async def handle_client_message(websocket, message):
    """Handle messages from clients"""
    global is_running
    
    try:
        data = json.loads(message)
        command = data.get('command')
        
        if command == 'start_tracking':
            if not is_running:
                # Start tracking in background task
                asyncio.create_task(start_mock_tracking())
            await send_to_client(websocket, {
                "type": "command_response",
                "data": {"status": "tracking_started" if not is_running else "already_running"}
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
                    "elephants_tracked": len(elephant_positions),
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
    logger.info("Starting Simple WebSocket Test Server...")
    logger.info("🐘 Real-time Elephant Tracking Server")
    logger.info("📡 WebSocket server: ws://localhost:8765") 
    logger.info("🎮 Ready for mock elephant tracking simulation")
    logger.info("🌐 Open http://localhost:5174 and click 'Connect to Server' -> 'Start Live'")
    
    # Start WebSocket server
    async with websockets.serve(handle_client, "localhost", 8765):
        logger.info("Server started successfully!")
        await asyncio.Future()  # Run forever

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Server stopped by user")