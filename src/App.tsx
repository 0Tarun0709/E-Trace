import { useState, useEffect } from 'react'
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



  // Load elephant tracking data when app starts
  useEffect(() => {
    loadElephantTrackingData()
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
          lat: -1.2921, // Masai Mara coordinates
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
        x: (obj.x - 800) * 10, // Larger offset for visibility (in meters)
        y: (obj.y - 500) * 10, // Larger offset for visibility (in meters)
        timestamp: obj.timestamp,
        objectType: obj.objectType || 'elephant',
        confidence: obj.confidence || 0.9,
        frameIndex: obj.frameIndex,
        frame_number: obj.frame_number
      }))

      setTrackingData(convertedData)
      setTotalPoints(convertedData.objects.length)

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
        trackingData={trackingData || undefined}
        currentPointIndex={currentPointIndex}
        isAnimating={isPlaying}
        isRealTime={false}
      />
      

      
      {/* Animation Controls */}
      {trackingData && (
        <div style={{
          position: 'absolute',
          top: '20px',
          left: '20px',
          backgroundColor: 'rgba(255, 255, 255, 0.95)',
          padding: '15px',
          borderRadius: '8px',
          border: '1px solid #ddd',
          zIndex: 1000,
          minWidth: '250px'
        }}>
          <h4 style={{ margin: '0 0 10px 0', color: '#2563eb' }}>🐘 Elephant Tracking</h4>
          
          {/* Data Loading */}
          <div style={{ marginBottom: '15px' }}>
            <button 
              onClick={loadElephantTrackingData}
              disabled={isLoading}
              style={{
                padding: '10px 20px',
                backgroundColor: '#10b981',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isLoading ? 'not-allowed' : 'pointer',
                width: '100%',
                fontSize: '14px',
                fontWeight: 'bold'
              }}
            >
              {isLoading ? '📥 Loading...' : '📊 Load Elephant Data'}
            </button>
          </div>
          
          {/* Playback Controls */}
          {trackingData && (
            <>
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
                  title="Select animation speed"
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
            </>
          )}
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