import { useEffect } from 'react'
import L from 'leaflet'

// Define the structure of your object tracking data
export interface ObjectTrackingPoint {
  id: string | number
  x: number  // relative to reference point
  y: number  // relative to reference point
  timestamp: number
  objectType?: string
  confidence?: number
}

export interface ObjectTrackingData {
  referencePoint: {
    lat: number
    lng: number
  }
  // Scale factor: how many meters per pixel/unit in your tracking data
  scale: {
    metersPerUnit: number  // e.g., if 1 unit = 1 meter, then this is 1
  }
  objects: ObjectTrackingPoint[]
}

interface ObjectTrackingLayerProps {
  map: L.Map | null
  trackingData: ObjectTrackingData | null
  showTrails?: boolean
}

const ObjectTrackingLayer = ({ map, trackingData, showTrails = true }: ObjectTrackingLayerProps) => {
  useEffect(() => {
    if (!map || !trackingData) return

    // Clear existing object layers
    map.eachLayer((layer) => {
      if (layer instanceof L.Marker && (layer as any)._isObjectMarker) {
        map.removeLayer(layer)
      }
      if (layer instanceof L.Polyline && (layer as any)._isObjectTrail) {
        map.removeLayer(layer)
      }
    })

    const { referencePoint, scale, objects } = trackingData

    // Function to convert local coordinates to lat/lng
    const localToLatLng = (x: number, y: number) => {
      // Convert units to meters
      const xMeters = x * scale.metersPerUnit
      const yMeters = y * scale.metersPerUnit
      
      // Convert meters to degrees (approximate)
      // 1 degree latitude ≈ 111,320 meters
      // 1 degree longitude varies by latitude
      const latOffset = yMeters / 111320
      const lngOffset = xMeters / (111320 * Math.cos(referencePoint.lat * Math.PI / 180))
      
      return {
        lat: referencePoint.lat + latOffset,
        lng: referencePoint.lng + lngOffset
      }
    }

    // Add reference point marker
    const refIcon = L.divIcon({
      className: 'reference-marker',
      html: '<div style="width: 12px; height: 12px; border-radius: 50%; background-color: #ef4444; border: 2px solid white; box-shadow: 0 0 10px rgba(239, 68, 68, 0.5);"></div>',
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    })

    const referenceMarker = L.marker([referencePoint.lat, referencePoint.lng], { icon: refIcon })
      .addTo(map)
      .bindPopup('📍 Reference Point')
    ;(referenceMarker as any)._isObjectMarker = true

    // Group objects by ID to create trails
    const objectGroups: { [key: string]: ObjectTrackingPoint[] } = {}
    objects.forEach(obj => {
      const key = obj.id.toString()
      if (!objectGroups[key]) {
        objectGroups[key] = []
      }
      objectGroups[key].push(obj)
    })

    // Colors for different objects
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#84cc16', '#f97316']

    Object.entries(objectGroups).forEach(([objectId, points], index) => {
      const color = colors[index % colors.length]
      
      // Sort points by timestamp
      const sortedPoints = points.sort((a, b) => a.timestamp - b.timestamp)
      
      if (showTrails && sortedPoints.length > 1) {
        // Create trail line
        const trailCoords = sortedPoints.map(point => {
          const coords = localToLatLng(point.x, point.y)
          return [coords.lat, coords.lng] as [number, number]
        })
        
        const trail = L.polyline(trailCoords, {
          color: color,
          weight: 2,
          opacity: 0.7,
        }).addTo(map)
        ;(trail as any)._isObjectTrail = true
        
        trail.bindPopup(`🛤️ Trail for Object ${objectId}`)
      }

      // Add markers for each point
      sortedPoints.forEach((point, pointIndex) => {
        const coords = localToLatLng(point.x, point.y)
        const isLatest = pointIndex === sortedPoints.length - 1
        
        // Create custom icon based on object type
        const getObjectEmoji = (objectType?: string) => {
          switch(objectType?.toLowerCase()) {
            case 'elephant': return '🐘'
            case 'vehicle': return '🚗'
            case 'person': return '🚶'
            case 'drone': return '🛸'
            default: return '📍'
          }
        }

        const markerIcon = L.divIcon({
          className: 'object-marker',
          html: `<div style="
            width: ${isLatest ? '20px' : '16px'}; 
            height: ${isLatest ? '20px' : '16px'}; 
            border-radius: 50%; 
            background-color: ${color}; 
            border: 2px solid white; 
            box-shadow: 0 0 10px ${color}40;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: ${isLatest ? '12px' : '10px'};
            ${isLatest ? 'animation: pulse 2s infinite;' : ''}
          ">${getObjectEmoji(point.objectType)}</div>
          <style>
            @keyframes pulse {
              0% { transform: scale(1); }
              50% { transform: scale(1.2); }
              100% { transform: scale(1); }
            }
          </style>`,
          iconSize: [isLatest ? 20 : 16, isLatest ? 20 : 16],
          iconAnchor: [isLatest ? 10 : 8, isLatest ? 10 : 8],
        })

        const marker = L.marker([coords.lat, coords.lng], { icon: markerIcon })
          .addTo(map)
          .bindPopup(`
            <div>
              <strong>Object ${objectId}</strong><br/>
              Type: ${point.objectType || 'Unknown'}<br/>
              Position: (${point.x.toFixed(2)}, ${point.y.toFixed(2)})<br/>
              Time: ${new Date(point.timestamp).toLocaleTimeString()}<br/>
              ${point.confidence ? `Confidence: ${(point.confidence * 100).toFixed(1)}%` : ''}
            </div>
          `)
        ;(marker as any)._isObjectMarker = true
      })
    })

    // Fit map to show all objects
    if (objects.length > 0) {
      const allCoords = objects.map(obj => {
        const coords = localToLatLng(obj.x, obj.y)
        return [coords.lat, coords.lng] as [number, number]
      })
      allCoords.push([referencePoint.lat, referencePoint.lng])
      
      const group = new L.FeatureGroup(allCoords.map(coord => L.marker(coord)))
      map.fitBounds(group.getBounds().pad(0.1))
    }

  }, [map, trackingData, showTrails])

  return null // This component doesn't render anything directly
}

export default ObjectTrackingLayer