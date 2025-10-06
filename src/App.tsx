import { useState, useEffect } from 'react'
import SimpleMap from './SimpleMap'
import { ObjectTrackingData } from './ObjectTrackingLayer'
import './App.css'

function App() {
  // Demo contacts list for SMS alerts (replace with real numbers in E.164 format)
  const CONTACTS: Array<{ id: string; name: string; role: 'farmer'|'officer'; phone: string }> = [
    // Example: { id: '1', name: 'Farmer A', role: 'farmer', phone: '+254700000000' },
  ]

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
  const [boundaryCenter, setBoundaryCenter] = useState<{ lat: number, lng: number } | null>(null)
  const [boundaryPickMode, setBoundaryPickMode] = useState<boolean>(false)
  const [boundaryCircles, setBoundaryCircles] = useState<Array<{ id: string, name?: string, center: { lat: number, lng: number }, radius: number }>>([])
  const [boundaryAddCircleMode, setBoundaryAddCircleMode] = useState<boolean>(false)
  // Realtime mode
  const [isRealtime, setIsRealtime] = useState<boolean>(false)
  const [realtimeActive, setRealtimeActive] = useState<boolean>(false) // starts when Play is clicked
  const [realtimeStatus, setRealtimeStatus] = useState<'idle'|'connecting'|'live'|'error'>('idle')
  const [realtimeError, setRealtimeError] = useState<string | null>(null)
  const [lastRealtimeTs, setLastRealtimeTs] = useState<number | null>(null)
  const [frameBasedData, setFrameBasedData] = useState<any | null>(null)

  // Tracker WS integration (to push boundary circles/nodes)
  const [trackerWsUrl, setTrackerWsUrl] = useState<string>('ws://localhost:8765')
  const [lastSyncStatus, setLastSyncStatus] = useState<string>('')

  // Send a one-off WS command to the Python tracker
  const sendTrackerCommand = async (payload: any): Promise<string> => {
    return new Promise((resolve, reject) => {
      try {
        const ws = new WebSocket(trackerWsUrl)
        const timeout = setTimeout(() => {
          try { ws.close() } catch {}
          reject(new Error('Tracker WS timeout'))
        }, 5000)
        ws.onopen = () => {
          ws.send(JSON.stringify(payload))
        }
        ws.onmessage = (ev) => {
          try {
            const txt = typeof ev.data === 'string' ? ev.data : ''
            const obj = txt ? JSON.parse(txt) : null
            if (obj && obj.type === 'command_response') {
              clearTimeout(timeout)
              resolve(txt)
              try { ws.close() } catch {}
            }
            // Ignore other messages like initial 'config'
          } catch {
            // ignore parse errors
          }
        }
        ws.onerror = () => {
          clearTimeout(timeout)
          reject(new Error('Tracker WS error'))
        }
      } catch (e) {
        reject(e as any)
      }
    })
  }

  const syncNodesToTracker = async () => {
    try {
      const config = {
        referencePoint: boundaryCenter || DEFAULT_REFERENCE_POINT,
        scale: { metersPerUnit: realtimeMetersPerUnit },
        boundaryCircles: boundaryCircles.map(c => ({ id: c.id, name: c.name, center: c.center, radius: c.radius }))
      }
      const payload = { command: 'set_config', config }
      setLastSyncStatus('Syncing...')
      const resp = await sendTrackerCommand(payload)
      setLastSyncStatus('✅ Synced nodes to tracker')
      setMessage('✅ Synced boundary circles to tracker')
      console.log('Tracker response:', resp)
    } catch (e) {
      console.error(e)
      setLastSyncStatus('❌ Sync failed')
      setError('Failed to sync nodes to tracker (check WS URL and server)')
    }
  }

  // Forward an alert message to the tracker to send SMS
  const sendAlertSmsViaTracker = async (message: string) => {
    try {
      const payload = { command: 'send_sms', message }
      await sendTrackerCommand(payload)
    } catch (e) {
      console.error('Failed to send alert SMS via tracker:', e)
      // Non-blocking: we still show the alert in UI even if SMS fails
    }
  }

  // Lock reference point for both static and realtime to avoid map center drift
  const DEFAULT_REFERENCE_POINT = { lat: -1.2921, lng: 34.7617 }
  // Realtime scale: tune this down; default 1 meter per unit (pixel)
  const [realtimeMetersPerUnit, setRealtimeMetersPerUnit] = useState<number>(1)
  
  // Elephant position tracking for E1 and E2
  const [elephantPositions, setElephantPositions] = useState<{
    elephant_1?: { x: number, y: number, timestamp?: number }
    elephant_2?: { x: number, y: number, timestamp?: number }
  }>({})
  // Map actual tracker IDs to UI labels (elephant_1 / elephant_2)
  const [idToLabel, setIdToLabel] = useState<Map<string, 'elephant_1' | 'elephant_2'>>(new Map())

  const resetElephantUiState = () => {
    setElephantPositions({})
    setElephantsOutsideBoundary(new Set())
    setIdToLabel(new Map())
  }

  // Minimal direct call to Supabase Edge Function (verify_jwt=false)
  async function sendSmsAlertDirect({
    contacts,
    message,
    alertId,
  }: {
    contacts: Array<{ id: string; name: string; phone: string; role: string }>
    message: string
    alertId: string
  }) {
    const url = 'https://axxaiaplxbjnynlamhpf.functions.supabase.co/send-sms'
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacts, message, alertId }),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`send-sms failed: ${res.status} ${errText}`)
    }
    return res.json()
  }



  // Load elephant tracking data when app starts
  useEffect(() => {
    loadElephantTrackingData()
  }, [])





  // Position update handler for E1 and E2
  const handlePositionUpdate = (elephantId: string, coordinates: { x: number, y: number }, timestamp?: number) => {
    // Resolve or assign a UI label for this ID
    let label = idToLabel.get(elephantId)
    if (!label) {
      // Assign first available label
      const used = new Set(idToLabel.values())
      if (!used.has('elephant_1')) label = 'elephant_1'
      else if (!used.has('elephant_2')) label = 'elephant_2'
      if (label) {
        setIdToLabel(prev => new Map(prev).set(elephantId, label!))
      } else {
        // Already tracking two; ignore additional IDs
        return
      }
    }
    setElephantPositions(prev => ({
      ...prev,
      [label!]: { x: coordinates.x, y: coordinates.y, timestamp }
    }))
  }
  
  // Boundary violation alert handler
  const handleBoundaryViolation = (elephantId: string, isViolation: boolean, coordinates: { x: number, y: number }) => {
    const wasOutside = elephantsOutsideBoundary.has(elephantId)
    // Map to UI label if possible
    let label = idToLabel.get(elephantId)
    if (!label) {
      const used = new Set(idToLabel.values())
      if (!used.has('elephant_1')) label = 'elephant_1'
      else if (!used.has('elephant_2')) label = 'elephant_2'
      if (label) setIdToLabel(prev => new Map(prev).set(elephantId, label!))
    }
    const key = label || elephantId

    if (isViolation && !elephantsOutsideBoundary.has(key)) {
      // Elephant just left the boundary
      setElephantsOutsideBoundary(prev => new Set([...prev, key]))
      const alertName = label || elephantId
      const alertMessage = `🚨 ALERT: ${alertName} has left the safe zone at position (${coordinates.x.toFixed(1)}, ${coordinates.y.toFixed(1)})`
      setBoundaryAlerts(prev => [...prev.slice(-4), alertMessage]) // Keep last 5 alerts
      setMessage(alertMessage)
      console.warn(alertMessage)
      // Forward this UI alert as an SMS via tracker Twilio path
      sendAlertSmsViaTracker(alertMessage)
    } else if (!isViolation && elephantsOutsideBoundary.has(key)) {
      // Elephant returned to the boundary
      setElephantsOutsideBoundary(prev => {
        const newSet = new Set(prev)
        newSet.delete(key)
        return newSet
      })
      const alertName = label || elephantId
      const returnMessage = `✅ ${alertName} has returned to the safe zone`
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

  const handleLocationClick = (lat: number, lng: number) => {
    if (boundaryPickMode) {
      setBoundaryCenter({ lat, lng })
      setBoundaryPickMode(false)
      setMessage(`Boundary center set to (${lat.toFixed(5)}, ${lng.toFixed(5)})`)
      return
    }
    if (boundaryAddCircleMode) {
      const id = `C${Date.now()}`
      const nextIndex = boundaryCircles.length + 1
      setBoundaryCircles(prev => [...prev, { id, name: `Circle ${nextIndex}`, center: { lat, lng }, radius: boundaryRadius }])
      setBoundaryAddCircleMode(false)
      setMessage(`Added circle ${id} at (${lat.toFixed(5)}, ${lng.toFixed(5)}) with radius ${boundaryRadius}m`)
      return
    }
    console.log(`Location clicked: ${lat}, ${lng}`)
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
    if (isRealtime) {
      // Start realtime polling on Play
      setRealtimeActive(true)
      setRealtimeStatus('connecting')
      setFrameBasedData(null)
      resetElephantUiState()
      setIsPlaying(false)
      setCurrentPointIndex(0)
      return
    }
    // Static playback
    if (currentPointIndex >= totalPoints) {
      setCurrentPointIndex(0)
    }
    setIsPlaying(true)
  }

  const pauseAnimation = () => {
    if (isRealtime) {
      setRealtimeActive(false)
      setRealtimeStatus('idle')
      return
    }
    setIsPlaying(false)
  }

  const resetAnimation = () => {
    if (isRealtime) {
      setRealtimeActive(false)
      setRealtimeStatus('idle')
      setFrameBasedData(null)
      resetElephantUiState()
    }
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

  // Realtime polling effect (starts only when realtimeActive is true)
  useEffect(() => {
    if (!(isRealtime && realtimeActive)) return
    let cancelled = false
    setRealtimeStatus((s) => (s === 'idle' ? 'connecting' : s))
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/latest_detections.json?t=${Date.now()}`, { cache: 'no-store' })
        if (!res.ok) return
        const latest = await res.json()
        if (cancelled) return

        // Always use the same reference point to keep the map centered.
        // For realtime, use the UI-controlled scale (ignore backend scale to avoid drift/mismatch).
        const metersPerUnit = realtimeMetersPerUnit
        const camera_config = {
          referencePoint: DEFAULT_REFERENCE_POINT,
          scale: { metersPerUnit }
        }

        setFrameBasedData((prev: any) => {
          const frames = prev?.frames ? [...prev.frames] : []
          const last = frames[frames.length - 1]
          const frame_number = latest.frame_number || (last ? last.frame_number + 1 : 1)
          if (!last || last.frame_number !== frame_number) {
            frames.push({
              frame_number,
              referencePoint: camera_config.referencePoint,
              scale: camera_config.scale,
              objects: Array.isArray(latest.objects) ? latest.objects.map((o: any) => ({ ...o })) : []
            })
          }
          const fb = {
            metadata: {
              total_frames: frames.length,
              fps: 0,
              video_duration: 0,
              camera_config
            },
            frames
          }
          return fb
        })
        // Handle error status from backend file
        if (latest && latest.status && latest.status.error) {
          setRealtimeStatus('error')
          setRealtimeError(String(latest.status.error))
        } else {
          setRealtimeStatus('live')
          setRealtimeError(null)
        }
        setLastRealtimeTs(Date.now())
      } catch (e) {
        // ignore transient errors but keep status informative
        setRealtimeStatus((s) => (s === 'idle' ? 'connecting' : s))
      }
    }, 1000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [isRealtime, realtimeActive])

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
        trackingData={!isRealtime ? (trackingData || undefined) : undefined}
        frameBasedData={isRealtime ? (frameBasedData || undefined) : undefined}
        currentPointIndex={currentPointIndex}
        isAnimating={isPlaying}
        isRealTime={isRealtime}
        onPositionUpdate={handlePositionUpdate}
        onBoundaryViolation={handleBoundaryViolation}
        onCircleEntry={(elephantId, circleId) => {
          const circle = boundaryCircles.find(c => c.id === circleId)
          const label = circle?.name || circleId
          const msg = `✅ ${elephantId} has entered circle ${label}`
          setBoundaryAlerts(prev => [...prev.slice(-4), msg])
          setMessage(msg)
          // Optional: send SMS for entries as well (comment out if not needed)
          // sendAlertSmsViaTracker(msg)
        }}
        onCircleExit={async (elephantId, circleId) => {
          // Node == circle; form the same alert message and forward to tracker for SMS
          const circle = boundaryCircles.find(c => c.id === circleId)
          const nodeLabel = circle?.name || circleId
          const alertId = `alert-${Date.now()}`
          const uiLabel = idToLabel.get(elephantId) || (elephantId as any)
          const msg = `🐘 ELEPHANT ALERT from node ${nodeLabel}: ${uiLabel} exited this zone. Alert ID: ${alertId}`

          setBoundaryAlerts(prev => [...prev.slice(-4), `🚨 Exited ${nodeLabel}: ${uiLabel}`])
          setMessage(`🚨 ${uiLabel} exited ${nodeLabel}`)
          // Send through the tracker Twilio path (mirrors --test-sms)
          sendAlertSmsViaTracker(msg)
        }}
        autoFitEnabled={autoFitEnabled}
        fitNowVersion={fitNowVersion}
        boundaryRadiusMeters={boundaryRadius}
        boundaryCenterLatLng={boundaryCenter || DEFAULT_REFERENCE_POINT}
        boundaryCircles={boundaryCircles}
      />
      

      
      {/* Animation Controls */}
      {(trackingData || isRealtime) && (
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
          {(trackingData || isRealtime) && (
            <>
              {/* Realtime Toggle */}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
                <label style={{ display: 'flex', alignItems: 'center', fontSize: '12px', color: '#374151' }}>
                  <input
                    type="checkbox"
                    checked={isRealtime}
                    onChange={(e) => {
                      const on = e.target.checked
                      setIsRealtime(on)
                      setIsPlaying(false)
                      setCurrentPointIndex(0)
                      setRealtimeActive(false)
                      setRealtimeStatus('idle')
                      resetElephantUiState()
                      if (!on) setFrameBasedData(null)
                    }}
                    style={{ marginRight: '6px' }}
                  />
                  Real-time mode (poll latest_detections.json)
                </label>
                {isRealtime && (
                  <span style={{ marginLeft: '8px', fontSize: '12px', color: realtimeStatus === 'live' ? '#10b981' : (realtimeStatus === 'error' ? '#ef4444' : '#f59e0b') }}>
                    • {realtimeStatus === 'live' ? 'Live' : realtimeStatus === 'connecting' ? 'Connecting…' : realtimeStatus === 'error' ? 'Error' : 'Idle'}
                    {realtimeStatus === 'live' && lastRealtimeTs ? ` (updated ${Math.max(0, Math.round((Date.now()-lastRealtimeTs)/1000))}s ago)` : ''}
                    {realtimeStatus === 'error' && realtimeError ? ` (${realtimeError})` : ''}
                  </span>
                )}
              </div>
              {/* Realtime scale control */}
              {isRealtime && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
                  <label style={{ fontSize: '12px', color: '#374151' }}>Realtime scale (m/unit):</label>
                  <input
                    type="number"
                    min={0.1}
                    max={20}
                    step={0.1}
                    value={realtimeMetersPerUnit}
                    onChange={(e) => setRealtimeMetersPerUnit(Math.max(0.1, Number(e.target.value) || 0.1))}
                    style={{ width: '90px', padding: '4px 6px', fontSize: '12px' }}
                  />
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
                <button 
                  onClick={startAnimation}
                  disabled={(!isRealtime && isPlaying) || (isRealtime && realtimeActive)}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: ((!isRealtime && isPlaying) || (isRealtime && realtimeActive)) ? '#ccc' : '#10b981',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: ((!isRealtime && isPlaying) || (isRealtime && realtimeActive)) ? 'not-allowed' : 'pointer'
                  }}
                >
                  ▶️ Play
                </button>
                <button 
                  onClick={pauseAnimation}
                  disabled={(!isRealtime && !isPlaying) || (isRealtime && !realtimeActive)}
                  style={{
                    padding: '6px 12px',
                    backgroundColor: ((!isRealtime && !isPlaying) || (isRealtime && !realtimeActive)) ? '#ccc' : '#f59e0b',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: ((!isRealtime && !isPlaying) || (isRealtime && !realtimeActive)) ? 'not-allowed' : 'pointer'
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

              {/* Progress (disabled in realtime) */}
              {!isRealtime && (
                <div style={{ fontSize: '12px', color: '#666', marginBottom: '10px' }}>
                  Progress: {currentPointIndex} / {totalPoints} points
                </div>
              )}

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

              {/* Boundary Center Controls */}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
                <label style={{ fontSize: '12px', color: '#374151' }}>
                  Boundary center:
                </label>
                <button
                  onClick={() => setBoundaryPickMode(true)}
                  disabled={boundaryPickMode}
                  title="Click this, then click on the map to set boundary center"
                  style={{ padding: '4px 8px', backgroundColor: boundaryPickMode ? '#ccc' : '#2563eb', color: 'white', border: 'none', borderRadius: '4px', cursor: boundaryPickMode ? 'not-allowed' : 'pointer', fontSize: '12px' }}
                >
                  {boundaryPickMode ? 'Click on map…' : 'Pick on map'}
                </button>
                <button
                  onClick={() => setBoundaryCenter(null)}
                  title="Reset boundary center to reference point"
                  style={{ padding: '4px 8px', backgroundColor: '#6b7280', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                >
                  Reset
                </button>
              </div>
              <div style={{ fontSize: '11px', color: '#64748b', marginTop: '-6px', marginBottom: '10px' }}>
                Center: {(boundaryCenter || DEFAULT_REFERENCE_POINT).lat.toFixed(5)}, {(boundaryCenter || DEFAULT_REFERENCE_POINT).lng.toFixed(5)}
              </div>

              {/* Multi-circle controls */}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
                <label style={{ fontSize: '12px', color: '#374151' }}>Multiple circles:</label>
                <button
                  onClick={() => setBoundaryAddCircleMode(true)}
                  disabled={boundaryAddCircleMode}
                  title="Click this, then click on the map to add a boundary circle at that point"
                  style={{ padding: '4px 8px', backgroundColor: boundaryAddCircleMode ? '#ccc' : '#10b981', color: 'white', border: 'none', borderRadius: '4px', cursor: boundaryAddCircleMode ? 'not-allowed' : 'pointer', fontSize: '12px' }}
                >
                  {boundaryAddCircleMode ? 'Click on map…' : 'Add circle on map'}
                </button>
                <button
                  onClick={() => setBoundaryCircles([])}
                  disabled={boundaryCircles.length === 0}
                  title="Remove all circles"
                  style={{ padding: '4px 8px', backgroundColor: boundaryCircles.length === 0 ? '#ccc' : '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: boundaryCircles.length === 0 ? 'not-allowed' : 'pointer', fontSize: '12px' }}
                >
                  Clear all
                </button>
                <button
                  onClick={syncNodesToTracker}
                  disabled={boundaryCircles.length === 0}
                  title="Send current circles to Python tracker via WebSocket"
                  style={{ padding: '4px 8px', backgroundColor: boundaryCircles.length === 0 ? '#ccc' : '#2563eb', color: 'white', border: 'none', borderRadius: '4px', cursor: boundaryCircles.length === 0 ? 'not-allowed' : 'pointer', fontSize: '12px' }}
                >
                  Sync nodes to Tracker
                </button>
              </div>
              {/* Tracker WS controls */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', alignItems: 'center', marginBottom: '10px' }}>
                <input
                  type="text"
                  value={trackerWsUrl}
                  onChange={(e) => setTrackerWsUrl(e.target.value)}
                  placeholder="ws://localhost:8765"
                  title="Tracker WebSocket URL"
                  style={{ padding: '4px 6px', fontSize: '12px', border: '1px solid #ddd', borderRadius: '4px' }}
                />
                <span style={{ fontSize: '12px', color: lastSyncStatus.startsWith('✅') ? '#10b981' : (lastSyncStatus.startsWith('❌') ? '#ef4444' : '#6b7280') }}>
                  {lastSyncStatus || 'Ready'}
                </span>
              </div>
              {boundaryCircles.length > 0 && (
                <div style={{ marginBottom: '10px', border: '1px solid #e5e7eb', borderRadius: '8px', padding: '8px', background: '#f9fafb' }}>
                  <div style={{ fontSize: '12px', color: '#374151', marginBottom: '6px', fontWeight: 600 }}>
                    Circles ({boundaryCircles.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '180px', overflowY: 'auto' }}>
                    {boundaryCircles.map((c, idx) => (
                      <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.3fr 1fr auto', gap: '6px', alignItems: 'center' }}>
                        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                          <input
                            type="text"
                            value={c.name || ''}
                            placeholder={`Circle ${idx + 1}`}
                            onChange={(e) => {
                              const val = e.target.value
                              setBoundaryCircles(prev => prev.map(x => x.id === c.id ? { ...x, name: val } : x))
                            }}
                            title="Circle name"
                            style={{ width: '100%', padding: '4px 6px', fontSize: '12px' }}
                          />
                        </div>
                        <div style={{ fontSize: '11px', color: '#6b7280' }}>({c.center.lat.toFixed(5)}, {c.center.lng.toFixed(5)})</div>
                        <div>
                          <input
                            type="number"
                            min={50}
                            max={10000}
                            step={50}
                            value={c.radius}
                            onChange={(e) => {
                              const val = Number(e.target.value) || 0
                              setBoundaryCircles(prev => prev.map(x => x.id === c.id ? { ...x, radius: val } : x))
                            }}
                            title="Radius (m)"
                            style={{ width: '100%', padding: '4px 6px', fontSize: '12px' }}
                          />
                        </div>
                        <button
                          onClick={() => setBoundaryCircles(prev => prev.filter(x => x.id !== c.id))}
                          title="Remove this circle"
                          style={{ padding: '4px 8px', backgroundColor: '#ef4444', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

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