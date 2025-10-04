import { useState, useEffect, useRef } from 'react'
import SimpleMap from './SimpleMap'
import { ObjectTrackingData } from './ObjectTrackingLayer'
import './App.css'

function App() {
  const [isLoading, setIsLoading] = useState(true)
  const [trackingData, setTrackingData] = useState<ObjectTrackingData | null>(null)
  const [showTrails, setShowTrails] = useState(true)
  const [message, setMessage] = useState('Loading elephant tracking data...')
  const [error, setError] = useState<string | null>(null)
  
  // Animation controls
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentPointIndex, setCurrentPointIndex] = useState(0)
  const [animationSpeed, setAnimationSpeed] = useState(10) // seconds between points
  const [totalPoints, setTotalPoints] = useState(0)

  // Real-time tracking controls
  const [isRealTimeMode, setIsRealTimeMode] = useState(false)
  const [isConnected, setIsConnected] = useState(false)
  const [liveTrackingData, setLiveTrackingData] = useState<ObjectTrackingData | null>(null)
  const [frameBasedData, setFrameBasedData] = useState<any>(null)
  const [wsStatus, setWsStatus] = useState('Disconnected')
  const [frameCount, setFrameCount] = useState(0)
  const [elephantsDetected, setElephantsDetected] = useState(0)
  const [boundaryData, setBoundaryData] = useState<any>(null)
  const [boundaryAlerts, setBoundaryAlerts] = useState<any[]>([])
  const [elephantsInBoundary, setElephantsInBoundary] = useState<string[]>([])
  
  const wsRef = useRef<WebSocket | null>(null)

  // Load elephant tracking data when app starts
  useEffect(() => {
    loadElephantTrackingData()
  }, [])

  // WebSocket connection for real-time tracking
  const connectToRealTimeTracking = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return // Already connected
    }

    try {
      const ws = new WebSocket('ws://localhost:8765')
      wsRef.current = ws

      ws.onopen = () => {
        console.log('🔌 Connected to real-time tracking server')
        setIsConnected(true)
        setWsStatus('Connected')
        setMessage('Connected to real-time tracking server')
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          console.log('📡 Received real-time data:', data.type)

          switch (data.type) {
            case 'config':
              console.log('Server config received:', data.data)
              break

            case 'tracking_data_loaded':
              console.log('📊 Complete tracking dataset received')
              setMessage('Tracking dataset loaded! Ready for animation.')
              setFrameBasedData(data.data) // Store frame-based dataset
              setBoundaryData(data.boundary)
              setFrameCount(0)
              setElephantsDetected(0)
              setLiveTrackingData(null) // Clear old data
              break

            case 'tracking_started':
              setMessage('Real-time tracking started!')
              setFrameCount(0)
              setBoundaryData(data.data.boundary)
              setLiveTrackingData({
                referencePoint: data.data.config.referencePoint,
                scale: data.data.config.scale,
                objects: []
              })
              break

            case 'animation_frame_update':
              const frameIndex = data.frame_index
              setFrameCount(frameIndex + 1) // 1-based for display
              setCurrentPointIndex(frameIndex) // For animation
              
              // Update elephants in boundary status
              if (data.elephants_in_boundary) {
                setElephantsInBoundary(data.elephants_in_boundary)
              }
              
              // Count elephants in current frame
              const currentFrameData = data.data
              setElephantsDetected(currentFrameData.objects.length)
              break

            case 'live_tracking_update':
              const frameData = data.data
              setFrameCount(frameData.frame_number)
              setElephantsDetected(frameData.objects.length)
              
              // Update elephants in boundary status
              if (frameData.elephants_in_boundary) {
                setElephantsInBoundary(frameData.elephants_in_boundary)
              }
              
              // Update live tracking data with new frame (legacy mode)
              setLiveTrackingData(prevData => {
                if (!prevData) {
                  return {
                    referencePoint: frameData.referencePoint,
                    scale: frameData.scale,
                    objects: frameData.objects
                  }
                }

                // Append new objects to existing data for trail building
                const updatedObjects = [...(prevData.objects || []), ...frameData.objects]
                
                // Keep only recent points to prevent memory issues (last 500 points)
                const recentObjects = updatedObjects.slice(-500)
                
                return {
                  ...prevData,
                  objects: recentObjects
                }
              })

              const alertCount = frameData.elephants_in_boundary?.length || 0
              const alertText = alertCount > 0 ? ` (🚨 ${alertCount} in restricted area!)` : ''
              setMessage(`Live: Frame ${frameData.frame_number} - ${frameData.objects.length} elephants${alertText}`)
              break

            case 'boundary_alert':
              const alert = data.data
              setBoundaryAlerts(prev => [...prev.slice(-4), alert]) // Keep last 5 alerts
              setMessage(`🚨 BOUNDARY ALERT: Elephant ${alert.elephant_id} entered restricted area!`)
              break

            case 'tracking_complete':
              setMessage(`Tracking complete! Processed ${data.data.total_frames} frames, found ${data.data.total_elephants} elephants`)
              break

            default:
              console.log('Unknown message type:', data.type)
          }
        } catch (err) {
          console.error('Error parsing WebSocket message:', err)
        }
      }

      ws.onerror = (error) => {
        console.error('❌ WebSocket error:', error)
        setWsStatus('Error')
        setError('WebSocket connection error')
      }

      ws.onclose = () => {
        console.log('🔌 WebSocket connection closed')
        setIsConnected(false)
        setWsStatus('Disconnected')
        setMessage('Disconnected from real-time server')
        wsRef.current = null
      }

    } catch (err) {
      console.error('Error connecting to WebSocket:', err)
      setError('Failed to connect to real-time server')
    }
  }

  const disconnectFromRealTimeTracking = () => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    setIsConnected(false)
    setWsStatus('Disconnected')
    setLiveTrackingData(null)
  }

  const startRealTimeTracking = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ command: 'start_tracking' }))
    }
  }

  const stopRealTimeTracking = () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ command: 'stop_tracking' }))
    }
  }

  // Cleanup WebSocket on unmount
  useEffect(() => {
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [])

  // Function to load elephant tracking data from JSON file
  const loadElephantTrackingData = async () => {
    setIsLoading(true)
    try {
      const response = await fetch('/corrected_tracking_data.json')
      if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.status}`);
      }
      const rawData = await response.json()
      
      console.log('Raw data loaded:', {
        frames: rawData.frames?.length || 0,
        metadata: rawData.metadata
      });
      
      // Convert the frame-based data to our format
      const convertedData: ObjectTrackingData = {
        referencePoint: { 
          lat: -1.2921, // Masai Mara, Kenya (typical elephant habitat)
          lng: 34.7617 
        },
        scale: { metersPerUnit: 1 }, // 1 unit = 1 meter
        objects: []
      }

      // Combine all objects from all frames, preserving frame order
      const allObjects: any[] = []
      if (rawData.frames) {
        rawData.frames.forEach((frame: any, frameIndex: number) => {
          if (frame.objects) {
            frame.objects.forEach((obj: any) => {
              allObjects.push({
                ...obj,
                frameIndex: frameIndex, // Add frame index for proper ordering
                frame_number: frame.frame_number // Keep original frame number
              })
            })
          }
        })
      }

      console.log(`📊 Total objects before sampling: ${allObjects.length}`);
      
      // Use moderate sampling: every 5th object instead of 3rd to balance performance and detail
      const sampledObjects = allObjects.filter((_, index) => index % 5 === 0)
      
      console.log(`📊 Objects after sampling: ${sampledObjects.length}`);
      
      convertedData.objects = sampledObjects.map((obj: any) => ({
        id: String(obj.id), // Ensure ID is string
        x: obj.x,
        y: obj.y, 
        timestamp: obj.timestamp,
        objectType: obj.objectType || 'elephant',
        confidence: obj.confidence || 0.9,
        frameIndex: obj.frameIndex,
        frame_number: obj.frame_number
      }))

      setTrackingData(convertedData)
      setTotalPoints(convertedData.objects.length)
      setFrameBasedData(null) // Clear frame-based data to ensure static mode
      setLiveTrackingData(null) // Clear live data too
      setMessage(`Loaded ${convertedData.objects.length} elephant tracking points - Ready for animation`)
      console.log(`Loaded ${convertedData.objects.length} elephant tracking points`)
      
    } catch (error) {
      console.error('Error loading tracking data:', error)
      setMessage(`Error loading tracking data: ${error}`)
      setError(`Failed to load tracking data: ${error}`)
    } finally {
      setIsLoading(false)
    }
  }

  const handleLocationClick = (lng: number, lat: number) => {
    console.log(`Location clicked: ${lat}, ${lng}`)
    // We can add video functionality later if needed
  }

  const handleTrailToggle = (checked: boolean) => {
    try {
      console.log('Toggling trails:', checked)
      setShowTrails(checked)
    } catch (err) {
      console.error('Error toggling trails:', err)
      setError('Error toggling trails')
    }
  }

  // Animation control functions
  const startAnimation = () => {
    setIsPlaying(true)
    setCurrentPointIndex(0)
  }

  const pauseAnimation = () => {
    setIsPlaying(false)
  }

  const resetAnimation = () => {
    setIsPlaying(false)
    setCurrentPointIndex(0)
  }

  // Animation timer effect
  useEffect(() => {
    if (!isPlaying || !trackingData || currentPointIndex >= totalPoints) {
      return
    }

    const timer = setTimeout(() => {
      setCurrentPointIndex(prev => {
        const next = prev + 1
        if (next >= totalPoints) {
          setIsPlaying(false) // Stop when reaching the end
          setMessage('Animation complete!')
        }
        return next
      })
    }, animationSpeed * 1000) // Convert seconds to milliseconds

    return () => clearTimeout(timer)
  }, [isPlaying, currentPointIndex, totalPoints, animationSpeed, trackingData])

  if (isLoading) {
    return (
      <div style={{ 
        display: 'flex', 
        justifyContent: 'center', 
        alignItems: 'center', 
        height: '100vh',
        flexDirection: 'column'
      }}>
        <h1>🐘 Elephant Tracking App</h1>
        <p>{message}</p>
        <div>Loading...</div>
      </div>
    )
  }

  return (
    <div className="App">
      <SimpleMap 
        onLocationClick={handleLocationClick} 
        trackingData={liveTrackingData || trackingData}
        frameBasedData={frameBasedData}
        currentPointIndex={frameBasedData ? frameCount - 1 : currentPointIndex}
        isAnimating={isPlaying || !!frameBasedData}
        isRealTime={!!frameBasedData}
        boundaryData={boundaryData}
        elephantsInBoundary={elephantsInBoundary}
      />
      
      {/* Real-time Controls */}
      <div style={{
        position: 'absolute',
        top: '20px',
        left: '20px',
        backgroundColor: 'rgba(255, 255, 255, 0.95)',
        padding: '15px',
        borderRadius: '8px',
        border: '1px solid #ddd',
        zIndex: 1000,
        minWidth: '280px'
      }}>
        <h4 style={{ margin: '0 0 10px 0', color: '#dc2626' }}>🔴 Real-time Tracking</h4>
        
        <div style={{ marginBottom: '10px', fontSize: '12px' }}>
          Status: <span style={{ 
            color: isConnected ? '#10b981' : '#ef4444',
            fontWeight: 'bold'
          }}>{wsStatus}</span>
        </div>

        {!isConnected ? (
          <button 
            onClick={connectToRealTimeTracking}
            style={{
              padding: '8px 16px',
              backgroundColor: '#2563eb',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              marginRight: '8px'
            }}
          >
            📡 Connect to Server
          </button>
        ) : (
          <div>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
              <button 
                onClick={startRealTimeTracking}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#10b981',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                🎬 Start Live
              </button>
              <button 
                onClick={stopRealTimeTracking}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#ef4444',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                ⏹️ Stop
              </button>
              <button 
                onClick={disconnectFromRealTimeTracking}
                style={{
                  padding: '6px 12px',
                  backgroundColor: '#6b7280',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer'
                }}
              >
                🔌 Disconnect
              </button>
            </div>
            
            {liveTrackingData && (
              <div style={{ fontSize: '12px', color: '#374151' }}>
                <div>📹 Frame: {frameCount}</div>
                <div>🐘 Elephants: {elephantsDetected}</div>
                <div>📊 Trail Points: {liveTrackingData.objects.length}</div>
              </div>
            )}
          </div>
        )}
      </div>
      
      {/* Animation Controls */}
      {trackingData && !liveTrackingData && (
        <div style={{
          position: 'absolute',
          top: '20px',
          right: '20px',
          backgroundColor: 'rgba(255, 255, 255, 0.95)',
          padding: '15px',
          borderRadius: '8px',
          border: '1px solid #ddd',
          zIndex: 1000,
          minWidth: '250px'
        }}>
          <h4 style={{ margin: '0 0 10px 0', color: '#2563eb' }}>🎬 Animation Controls</h4>
          
          {/* Playback Controls */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
            <button 
              onClick={startAnimation}
              disabled={isPlaying}
              style={{
                padding: '6px 12px',
                backgroundColor: isPlaying ? '#ccc' : '#10b981',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isPlaying ? 'not-allowed' : 'pointer'
              }}
            >
              ▶️ Play
            </button>
            <button 
              onClick={pauseAnimation}
              disabled={!isPlaying}
              style={{
                padding: '6px 12px',
                backgroundColor: !isPlaying ? '#ccc' : '#f59e0b',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: !isPlaying ? 'not-allowed' : 'pointer'
              }}
            >
              ⏸️ Pause
            </button>
            <button 
              onClick={resetAnimation}
              style={{
                padding: '6px 12px',
                backgroundColor: '#ef4444',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              ⏹️ Reset
            </button>
          </div>

          {/* Speed Control */}
          <div style={{ marginBottom: '10px' }}>
            <label style={{ fontSize: '12px', color: '#666' }}>Animation Speed:</label>
            <select 
              value={animationSpeed}
              onChange={(e) => setAnimationSpeed(Number(e.target.value))}
              style={{ 
                marginLeft: '5px',
                padding: '2px 5px',
                fontSize: '12px'
              }}
            >
              <option value={1}>1 sec/point</option>
              <option value={5}>5 sec/point</option>
              <option value={10}>10 sec/point</option>
              <option value={20}>20 sec/point</option>
            </select>
          </div>

          {/* Progress */}
          <div style={{ fontSize: '12px', color: '#666', marginBottom: '10px' }}>
            Progress: {currentPointIndex} / {totalPoints} points
          </div>

          {/* Trail Toggle */}
          <label style={{ display: 'flex', alignItems: 'center', fontSize: '14px', color: '#2563eb' }}>
            <input 
              type="checkbox" 
              checked={showTrails}
              onChange={(e) => handleTrailToggle(e.target.checked)}
              style={{ marginRight: '8px' }}
            />
            🐘 Show Trail
          </label>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div style={{
          position: 'absolute',
          top: '80px',
          right: '20px',
          backgroundColor: 'rgba(255, 0, 0, 0.9)',
          color: 'white',
          padding: '10px',
          borderRadius: '8px',
          zIndex: 1000,
          fontSize: '14px'
        }}>
          Error: {error}
        </div>
      )}

      {/* Status Message */}
      <div style={{
        position: 'absolute',
        bottom: '20px',
        left: '20px',
        backgroundColor: 'rgba(255, 255, 255, 0.9)',
        padding: '10px',
        borderRadius: '8px',
        border: '1px solid #ddd',
        zIndex: 1000,
        fontSize: '14px'
      }}>
        {message}
      </div>
    </div>
  )
}

export default App