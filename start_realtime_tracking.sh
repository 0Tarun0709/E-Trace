#!/bin/bash

# Real-time Elephant Tracking Startup Script
echo "🐘 Starting Real-time Elephant Tracking System..."

# Kill any existing processes
echo "🔄 Cleaning up existing processes..."
pkill -f "realtime_tracker.py" 2>/dev/null || true
pkill -f "npm run dev" 2>/dev/null || true

# Start Python WebSocket server in background
echo "🚀 Starting WebSocket tracking server..."
cd "$(dirname "$0")"
source venv/bin/activate
python realtime_tracker.py &
SERVER_PID=$!

# Wait a moment for server to start
sleep 3

# Start React development server
echo "🌐 Starting React frontend..."
npm run dev &
FRONTEND_PID=$!

echo "🎉 System started successfully!"
echo "📡 WebSocket Server: ws://localhost:8765 (PID: $SERVER_PID)"
echo "🌐 React Frontend: http://localhost:5173 (PID: $FRONTEND_PID)"
echo ""
echo "💡 Instructions:"
echo "1. Open http://localhost:5173 in your browser"
echo "2. Click 'Connect to Server' in the real-time panel"
echo "3. Click 'Start Live' to begin processing video"
echo "4. Watch elephants appear on the map in real-time!"
echo ""
echo "⏹️  To stop: Press Ctrl+C or run 'pkill -f realtime_tracker.py && pkill -f \"npm run dev\"'"

# Function to cleanup on script termination
cleanup() {
    echo ""
    echo "🛑 Shutting down system..."
    kill $SERVER_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    pkill -f "realtime_tracker.py" 2>/dev/null || true
    pkill -f "npm run dev" 2>/dev/null || true
    echo "✅ Cleanup complete"
    exit 0
}

# Trap Ctrl+C and other termination signals
trap cleanup SIGINT SIGTERM

# Wait for user to press Ctrl+C
wait