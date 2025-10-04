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
  
  // Boundary violation tracking
  const [boundaryAlerts, setBoundaryAlerts] = useState<string[]>([])
  const [elephantsOutsideBoundary, setElephantsOutsideBoundary] = useState<Set<string>>(new Set())
  // Map viewport controls
  const [autoFitEnabled, setAutoFitEnabled] = useState(false)
  const [fitNowVersion, setFitNowVersion] = useState(0)
  // Boundary radius (meters)
  const [boundaryRadius, setBoundaryRadius] = useState<number>(500)
  
  // Elephant position tracking for E1 and E2
  const [elephantPositions, setElephantPositions] = useState<{
    elephant_1?: { x: number, y: number, timestamp?: number }
    elephant_2?: { x: number, y: number, timestamp?: number }
  }>({})



  // Load elephant tracking data when app starts
  useEffect(() => {
    loadElephantTrackingData()
  }, [])





  // Position update handler for E1 and E2
  const handlePositionUpdate = (elephantId: string, coordinates: { x: number, y: number }, timestamp?: number) => {
    if (elephantId === 'elephant_1' || elephantId === 'elephant_2') {
      setElephantPositions(prev => ({
        ...prev,
        [elephantId]: { x: coordinates.x, y: coordinates.y, timestamp }
      }))
    }
  }
  
  // Boundary violation alert handler
  const handleBoundaryViolation = (elephantId: string, isViolation: boolean, coordinates: { x: number, y: number }) => {
    const wasOutside = elephantsOutsideBoundary.has(elephantId)
    
    if (isViolation && !wasOutside) {
      // Elephant just left the boundary
      setElephantsOutsideBoundary(prev => new Set([...prev, elephantId]))
      const alertMessage = `🚨 ALERT: ${elephantId} has left the safe zone at position (${coordinates.x.toFixed(1)}, ${coordinates.y.toFixed(1)})`
      setBoundaryAlerts(prev => [...prev.slice(-4), alertMessage]) // Keep last 5 alerts
      setMessage(alertMessage)
      console.warn(alertMessage)
    } else if (!isViolation && wasOutside) {
      // Elephant returned to the boundary
      setElephantsOutsideBoundary(prev => {
        const newSet = new Set(prev)
        newSet.delete(elephantId)
        return newSet
      })
      const returnMessage = `✅ ${elephantId} has returned to the safe zone`
      setBoundaryAlerts(prev => [...prev.slice(-4), returnMessage])
      setMessage(returnMessage)
      console.log(returnMessage)
    }
  }

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
    // If at the end, restart from beginning, otherwise resume from current position
    if (currentPointIndex >= totalPoints) {
      setCurrentPointIndex(0)
    }
    setIsPlaying(true)
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
        onPositionUpdate={handlePositionUpdate}
        onBoundaryViolation={handleBoundaryViolation}
        autoFitEnabled={autoFitEnabled}
        fitNowVersion={fitNowVersion}
        boundaryRadiusMeters={boundaryRadius}
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

              {/* Map Viewport */}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
                <label style={{ display: 'flex', alignItems: 'center', fontSize: '12px', color: '#374151' }}>
                  <input
                    type="checkbox"
                    checked={autoFitEnabled}
                    onChange={(e) => setAutoFitEnabled(e.target.checked)}
                    style={{ marginRight: '6px' }}
                  />
                  Auto-fit map to elephants
                </label>
                <button
                  onClick={() => setFitNowVersion(v => v + 1)}
                  style={{
                    padding: '4px 8px',
                    backgroundColor: '#2563eb',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '12px'
                  }}
                >
                  Fit now
                </button>
              </div>

              {/* Boundary Radius */}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
                <label style={{ fontSize: '12px', color: '#374151' }}>Boundary radius (m):</label>
                <input
                  type="number"
                  min={50}
                  max={10000}
                  step={50}
                  value={boundaryRadius}
                  onChange={(e) => setBoundaryRadius(Number(e.target.value) || 0)}
                  style={{ width: '90px', padding: '4px 6px', fontSize: '12px' }}
                />
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

      {/* Boundary Alerts Display */}
      {boundaryAlerts.length > 0 && (
        <div style={{
          position: 'absolute',
          top: '80px',
          right: '20px',
          backgroundColor: 'rgba(0, 0, 0, 0.9)',
          color: 'white',
          padding: '12px',
          borderRadius: '8px',
          zIndex: 1000,
          fontSize: '13px',
          maxWidth: '300px',
          maxHeight: '200px',
          overflowY: 'auto'
        }}>
          <h4 style={{ margin: '0 0 8px 0', fontSize: '14px', fontWeight: 'bold' }}>🚨 Boundary Alerts</h4>
          {boundaryAlerts.slice(-5).map((alert, index) => (
            <div key={index} style={{ 
              marginBottom: '4px', 
              paddingBottom: '4px',
              borderBottom: index < boundaryAlerts.slice(-5).length - 1 ? '1px solid #444' : 'none'
            }}>
              {alert}
            </div>
          ))}
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div style={{
          position: 'absolute',
          top: boundaryAlerts.length > 0 ? '320px' : '80px',
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

      {/* E1 & E2 Position Tracker */}
      <div style={{
        position: 'absolute',
        bottom: '20px',
        left: '20px',
        backgroundColor: 'rgba(0, 0, 0, 0.85)',
        color: 'white',
        padding: '16px',
        borderRadius: '12px',
        border: '2px solid #374151',
        boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
        zIndex: 1000,
        fontSize: '14px',
        minWidth: '300px',
        fontFamily: 'monospace'
      }}>
        <div style={{ 
          fontSize: '16px', 
          fontWeight: 'bold',
          marginBottom: '12px',
          color: '#10b981',
          textAlign: 'center'
        }}>
          🐘 Live Position Tracker
        </div>
        
        {/* Elephant 1 Position */}
        <div style={{ 
          marginBottom: '10px',
          padding: '8px 12px',
          backgroundColor: 'rgba(239, 68, 68, 0.2)',
          borderRadius: '8px',
          border: '1px solid #ef4444'
        }}>
          <div style={{ fontWeight: 'bold', color: '#ef4444', marginBottom: '4px' }}>🐘 Elephant 1</div>
          {elephantPositions.elephant_1 ? (
            <>
              <div>X: {elephantPositions.elephant_1.x.toFixed(1)}</div>
              <div>Y: {elephantPositions.elephant_1.y.toFixed(1)}</div>
              <div style={{ fontSize: '12px', color: '#9ca3af' }}>
                Status: {elephantsOutsideBoundary.has('elephant_1') ? '🚨 Outside' : '✅ Safe'}
              </div>
            </>
          ) : (
            <div style={{ color: '#9ca3af', fontStyle: 'italic' }}>No data</div>
          )}
        </div>
        
        {/* Elephant 2 Position */}
        <div style={{ 
          marginBottom: '8px',
          padding: '8px 12px',
          backgroundColor: 'rgba(59, 130, 246, 0.2)',
          borderRadius: '8px',
          border: '1px solid #3b82f6'
        }}>
          <div style={{ fontWeight: 'bold', color: '#3b82f6', marginBottom: '4px' }}>� Elephant 2</div>
          {elephantPositions.elephant_2 ? (
            <>
              <div>X: {elephantPositions.elephant_2.x.toFixed(1)}</div>
              <div>Y: {elephantPositions.elephant_2.y.toFixed(1)}</div>
              <div style={{ fontSize: '12px', color: '#9ca3af' }}>
                Status: {elephantsOutsideBoundary.has('elephant_2') ? '🚨 Outside' : '✅ Safe'}
              </div>
            </>
          ) : (
            <div style={{ color: '#9ca3af', fontStyle: 'italic' }}>No data</div>
          )}
        </div>
        
        {/* Quick Stats */}
        <div style={{ 
          fontSize: '11px', 
          color: '#9ca3af', 
          textAlign: 'center',
          marginTop: '8px',
          paddingTop: '8px',
          borderTop: '1px solid #374151'
        }}>
          Boundary Violations: {elephantsOutsideBoundary.size}/2
        </div>
      </div>
    </div>
  )
}

export default App