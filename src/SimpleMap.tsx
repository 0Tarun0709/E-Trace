import React, { useRef, useEffect } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix default markers
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

// Data types (string IDs supported)
export type FrameObject = {
  id: string; // e.g., "elephant_1"
  x: number;
  y: number;
  timestamp?: number;
  objectType?: string;
  confidence?: number;
  frameIndex?: number; // For animation ordering
};

export interface TrackingData {
  referencePoint: {
    lat: number;
    lng: number;
  };
  scale: {
    metersPerUnit: number;
  };
  objects: FrameObject[];
}

// Frame-based data for real-time streaming
export interface FrameBasedData {
  metadata?: {
    total_frames: number;
    fps: number;
    video_duration: number;
    camera_config: {
      referencePoint: { lat: number; lng: number };
      scale: { metersPerUnit: number };
    };
  };
  frames?: Array<{
    frame_number: number;
    referencePoint: { lat: number; lng: number };
    scale: { metersPerUnit: number };
    objects: FrameObject[];
  }>;
}

export type BoundaryConfig = {
  enabled?: boolean;
  name?: string;
  coordinates: [number, number][];
};

interface SimpleMapProps {
  trackingData?: TrackingData;
  frameBasedData?: FrameBasedData;
  isRealTime?: boolean;
  boundaryData?: BoundaryConfig;
  elephantsInBoundary?: string[];
  onLocationClick?: (lat: number, lng: number) => void;
  onBoundaryViolation?: (elephantId: string, isViolation: boolean, coordinates: { x: number, y: number }) => void;
  onPositionUpdate?: (elephantId: string, coordinates: { x: number, y: number }, timestamp?: number) => void;
  onCircleEntry?: (elephantId: string, circleId: string) => void;
  isAnimating?: boolean;
  currentPointIndex?: number;
  // Viewport controls
  autoFitEnabled?: boolean;
  fitNowVersion?: number;
  // Unified boundary radius (meters) used both for circle and violation logic
  boundaryRadiusMeters?: number;
  // Optional boundary center (lat/lng). Defaults to referencePoint if not provided
  boundaryCenterLatLng?: { lat: number; lng: number };
  // Multiple boundary circles support
  boundaryCircles?: Array<{ id: string; center: { lat: number; lng: number }; radius: number }>;
}

const SimpleMap: React.FC<SimpleMapProps> = ({ 
  trackingData,
  frameBasedData,
  onLocationClick,
  onBoundaryViolation,
  onPositionUpdate,
  onCircleEntry,
  isAnimating = false,
  currentPointIndex = 0,
  isRealTime = false,
  boundaryData,
  elephantsInBoundary = [],
  autoFitEnabled = false,
  fitNowVersion,
  boundaryRadiusMeters = 500,
  boundaryCenterLatLng,
  boundaryCircles
}) => {
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const markersRef = useRef<L.Marker[]>([]);
  const trailsRef = useRef<L.Polyline[]>([]);
  const elephantMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  const elephantTrailsRef = useRef<Map<string, L.Polyline>>(new Map());
  const elephantPathsRef = useRef<Map<string, Array<[number, number]>>>(new Map());
  // Per-elephant start markers (static once created)
  const elephantStartMarkersRef = useRef<Map<string, L.Marker>>(new Map());
  const boundaryRef = useRef<L.Polygon | null>(null);
  const boundaryCircleRef = useRef<L.Circle | null>(null);
  const boundaryCirclesLayerRef = useRef<Map<string, L.Circle>>(new Map());
  // Track which circles each elephant is currently inside (to detect entries)
  const elephantInsideCirclesRef = useRef<Map<string, Set<string>>>(new Map());
  const lastModeRef = useRef('');
  const hasFitBoundsRef = useRef(false);
  const lastFitNowVersionRef = useRef<number | undefined>(undefined);

  // Initialize map (run once)
  useEffect(() => {
    if (mapContainerRef.current && !mapRef.current) {
      mapRef.current = L.map(mapContainerRef.current).setView([-1.2921, 34.7617], 13);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
      }).addTo(mapRef.current);
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Update click handler when callback changes without destroying the map
  useEffect(() => {
    if (!mapRef.current) return;
    mapRef.current.off('click');
    if (onLocationClick) {
      mapRef.current.on('click', (e: L.LeafletMouseEvent) => {
        const { lat, lng } = e.latlng;
        onLocationClick(lat, lng);
      });
    }
  }, [onLocationClick]);

  // Ensure Leaflet recalculates size after mount to avoid invisible tiles
  useEffect(() => {
    if (mapRef.current) {
      // Defer to next tick in case parent layout is not settled yet
      setTimeout(() => {
        mapRef.current && mapRef.current.invalidateSize();
      }, 0);
    }
  }, []);

  // Reset fit-bounds flag whenever data source changes
  useEffect(() => {
    hasFitBoundsRef.current = false;
  }, [trackingData, frameBasedData]);

  // Invalidate size on window resize
  useEffect(() => {
    const onResize = () => {
      if (mapRef.current) {
        mapRef.current.invalidateSize();
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // UNIFIED effect to handle both initialization and animation
  useEffect(() => {
    if (!mapRef.current) return;
    
    // Clear trails when switching data modes to prevent accumulation
    const currentMode = frameBasedData ? 'realtime' : trackingData ? 'static' : 'none';
    
    // Clear trails when switching between modes
    if (currentMode !== lastModeRef.current) {
      elephantPathsRef.current.clear();
      elephantTrailsRef.current.forEach(trail => mapRef.current?.removeLayer(trail));
      elephantTrailsRef.current.clear();
      elephantMarkersRef.current.forEach(marker => mapRef.current?.removeLayer(marker));
      elephantMarkersRef.current.clear();
      elephantStartMarkersRef.current.forEach(marker => mapRef.current?.removeLayer(marker));
      elephantStartMarkersRef.current.clear();
      lastModeRef.current = currentMode;
    }
    
    // Determine which data source to use
    let currentData: TrackingData | null = null;
    let frames: any[] = [];
    let referencePoint: { lat: number; lng: number };
    let scale: { metersPerUnit: number };
    
  if (frameBasedData?.frames) {
      // Real-time frame-based data
      frames = frameBasedData.frames;
      const cameraConfig = frameBasedData.metadata?.camera_config || frames[0];
      referencePoint = cameraConfig.referencePoint;
      // We'll convert pixels to meters explicitly below and then use scale=1 in localToLatLng
      // to avoid double scaling.
      scale = { metersPerUnit: 1 };
      
  // Convert frame-based to object-based for animation
  const allObjects: FrameObject[] = [];
  // In realtime mode process only the latest frame; in playback, limit by current index
      if (isRealTime) {
        const i = Math.max(0, frames.length - 1);
        const frame = frames[i];
        // Dedupe per elephant ID within the same frame; keep the highest confidence or last seen
        const perId = new Map<string, FrameObject & { confidence?: number }>();
        frame.objects.forEach((obj: FrameObject & { confidence?: number }) => {
          const id = String(obj.id);
          const existing = perId.get(id);
          if (!existing || ((obj.confidence || 0) >= (existing.confidence || 0))) {
            perId.set(id, obj);
          }
        });
        perId.forEach((obj) => {
          const mPerUnit = (cameraConfig.scale && typeof cameraConfig.scale.metersPerUnit === 'number') ? cameraConfig.scale.metersPerUnit : 1;
          const xMeters = (obj.x - 800) * mPerUnit;
          const yMeters = (obj.y - 500) * mPerUnit;
          allObjects.push({ ...obj, x: xMeters, y: yMeters, frameIndex: i });
        });
      } else {
        const maxFrames = Math.min(currentPointIndex + 1, frames.length);
        for (let i = 0; i < maxFrames; i++) {
          const frame = frames[i];
          frame.objects.forEach((obj: FrameObject) => {
            const mPerUnit = (cameraConfig.scale && typeof cameraConfig.scale.metersPerUnit === 'number') ? cameraConfig.scale.metersPerUnit : 1;
            const xMeters = (obj.x - 800) * mPerUnit;
            const yMeters = (obj.y - 500) * mPerUnit;
            allObjects.push({ ...obj, x: xMeters, y: yMeters, frameIndex: i });
          });
        }
      }
      
      currentData = {
        referencePoint,
        scale: { metersPerUnit: 1 }, // already converted to meters above
        objects: allObjects
      };
    } else if (trackingData) {
      // Static tracking data with animation limiting
      referencePoint = trackingData.referencePoint;
      scale = trackingData.scale;

      // Always limit objects based on animation progress
      const maxObjects = Math.min(currentPointIndex + 1, trackingData.objects.length);
      const visibleObjects = trackingData.objects.slice(0, maxObjects);

      currentData = {
        referencePoint,
        scale,
        objects: visibleObjects
      };
    } else {
      return; // No data available
    }

    console.log(`🚀 UNIFIED EFFECT: ${currentData.objects.length} objects, isAnimating: ${isAnimating}, frame: ${currentPointIndex + 1}`);
    console.log(`📊 Data mode: ${currentMode}, isRealTime: ${isRealTime}`);
    console.log(`📍 frameBasedData:`, frameBasedData ? `${frameBasedData.frames?.length || 0} frames` : 'none');
    console.log(`📍 trackingData:`, trackingData ? `${trackingData.objects?.length || 0} objects` : 'none');

    try {

      // Clear reference markers and trails (not elephant-specific ones)
      markersRef.current.forEach(marker => mapRef.current?.removeLayer(marker));
      trailsRef.current.forEach(trail => mapRef.current?.removeLayer(trail));
      
      // Note: Per-elephant start markers persist; do not clear them here
      if (boundaryRef.current) {
        mapRef.current.removeLayer(boundaryRef.current);
        boundaryRef.current = null;
      }
      if (boundaryCircleRef.current) {
        mapRef.current.removeLayer(boundaryCircleRef.current);
        boundaryCircleRef.current = null;
      }
      // Clear any multi-circles
      if (boundaryCirclesLayerRef.current.size > 0) {
        boundaryCirclesLayerRef.current.forEach(c => mapRef.current?.removeLayer(c));
        boundaryCirclesLayerRef.current.clear();
      }
      
      markersRef.current = [];
      trailsRef.current = [];

      // Add boundary visualization if available
      if (boundaryData && boundaryData.enabled && boundaryData.coordinates) {
        boundaryRef.current = L.polygon(boundaryData.coordinates, {
          color: '#ff0000',
          weight: 3,
          opacity: 0.8,
          fillColor: '#ff0000',
          fillOpacity: 0.1,
          dashArray: '10, 5'
        }).addTo(mapRef.current);
        
        boundaryRef.current.bindPopup(`🚨 ${boundaryData.name || 'Restricted Area'}`);
        console.log('🚨 Boundary added to map:', boundaryData.coordinates.length, 'points');
      }

      // Function to convert local coordinates to lat/lng
      const localToLatLng = (x: number, y: number) => {
        const xMeters = x * scale.metersPerUnit;
        const yMeters = y * scale.metersPerUnit;
        
        const latOffset = yMeters / 111320;
        const lngOffset = xMeters / (111320 * Math.cos(referencePoint.lat * Math.PI / 180));
        
        return {
          lat: referencePoint.lat + latOffset,
          lng: referencePoint.lng + lngOffset
        };
      };

      // Removed distance calculation - no longer needed for trail logic

      if (currentData.objects.length > 0) {
        // Thresholds for filtering near the reference point
        const centerSkipMeters = 1; // 1 meter
        const centerSkipLat = centerSkipMeters / 111320;
        const centerSkipLng = centerSkipMeters / (111320 * Math.cos(referencePoint.lat * Math.PI / 180));
        // Determine how many objects to show
        const useAll = isRealTime && !!frameBasedData;
        const visibleObjectCount = useAll ? currentData.objects.length : Math.min(currentPointIndex + 1, currentData.objects.length);
        const visibleObjects = useAll ? currentData.objects : currentData.objects.slice(0, visibleObjectCount);
        
        console.log(`📍 Processing objects: ${visibleObjectCount}/${currentData.objects.length}`);

        // 1. Reference point marker omitted intentionally to avoid any visual linkage with trails

        // 1.1. Add green boundary circle(s)
          if (boundaryCircles && boundaryCircles.length > 0) {
            boundaryCircles.forEach((bc) => {
              const circle = L.circle([bc.center.lat, bc.center.lng], {
                color: '#22c55e',
                weight: 3,
                opacity: 0.8,
                fillColor: '#22c55e',
                fillOpacity: 0.1,
                radius: bc.radius
              }).addTo(mapRef.current!);
              circle.bindPopup(`🟢 Boundary ${bc.id} (${bc.radius}m)`);
              boundaryCirclesLayerRef.current.set(bc.id, circle);
            });
            console.log(`🟢 Boundary circles added: ${boundaryCircles.length}`);
          } else {
            const centerLatLng = boundaryCenterLatLng || referencePoint;
            boundaryCircleRef.current = L.circle([centerLatLng.lat, centerLatLng.lng], {
              color: '#22c55e',
              weight: 3,
              opacity: 0.8,
              fillColor: '#22c55e',
              fillOpacity: 0.1,
              radius: boundaryRadiusMeters // meters
            }).addTo(mapRef.current);
            boundaryCircleRef.current.bindPopup(`🟢 Tracking Boundary (${boundaryRadiusMeters}m radius)`);
            console.log(`🟢 Boundary circle added to map: ${boundaryRadiusMeters}m radius`);
          }

        // 2. Process objects to build elephant trails
        const elephantGroups = new Map<string, FrameObject[]>();
        
        // Group objects by elephant ID
        visibleObjects.forEach((obj: FrameObject) => {
          const elephantId = String(obj.id);
          if (!elephantGroups.has(elephantId)) {
            elephantGroups.set(elephantId, []);
          }
          elephantGroups.get(elephantId)!.push(obj);
        });

        // Create trails and markers for each elephant
        elephantGroups.forEach((elephantObjects, elephantId) => {
          // Sort objects chronologically to ensure proper trail order
          const sortedObjects = elephantObjects.sort((a, b) => {
            // First sort by frameIndex if available, then by timestamp
            if (a.frameIndex !== undefined && b.frameIndex !== undefined) {
              return a.frameIndex - b.frameIndex;
            }
            return (a.timestamp || 0) - (b.timestamp || 0);
          });
          
          // Build trail coordinates for this elephant in chronological order
          // Skip near-center points to avoid segments connecting to the reference point
          const centerSkipMeters = 1; // drop points within 1 meter of center
          const elephantCoords: [number, number][] = [];
          for (const obj of sortedObjects) {
            const distFromCenterM = Math.hypot(obj.x, obj.y); // obj.x/obj.y are meter offsets in realtime
            if (distFromCenterM < centerSkipMeters) {
              // Skip near-center detections to prevent drawing lines to the reference point
              continue;
            }
            const coords = localToLatLng(obj.x, obj.y);
            elephantCoords.push([coords.lat, coords.lng]);
          }
          
          // For static data mode, rebuild trail completely from sorted data
          // For real-time mode, accumulate points
          let finalTrail: [number, number][];
          
          if (trackingData && !frameBasedData) {
            // Static mode: use the complete sorted trail
            finalTrail = elephantCoords;
          } else {
            // Real-time mode: accumulate trail points
            let existingTrail = elephantPathsRef.current.get(elephantId) || [];
            // Remove any existing trail points too close to the reference point (distance-based)
            const refLat = referencePoint.lat;
            const refLng = referencePoint.lng;
            const centerSkipLat = centerSkipMeters / 111320;
            const centerSkipLng = centerSkipMeters / (111320 * Math.cos(refLat * Math.PI / 180));
            let updatedTrail = existingTrail.filter(([lat, lng]) => !(Math.abs(lat - refLat) < centerSkipLat && Math.abs(lng - refLng) < centerSkipLng));
            
            for (const newPoint of elephantCoords) {
              const lastPoint = updatedTrail[updatedTrail.length - 1];
              const isDuplicate = lastPoint && 
                Math.abs(lastPoint[0] - newPoint[0]) < 0.00001 && 
                Math.abs(lastPoint[1] - newPoint[1]) < 0.00001;
              const isRefPoint = Math.abs(newPoint[0] - refLat) < centerSkipLat && Math.abs(newPoint[1] - refLng) < centerSkipLng;
              
              if (!isDuplicate && !isRefPoint) {
                updatedTrail.push(newPoint);
              }
            }
            
            finalTrail = updatedTrail;
          }
          
          // Limit trail length to prevent memory issues (keep last 1000 points)
          if (finalTrail.length > 1000) {
            finalTrail = finalTrail.slice(-1000);
          }
          
          // Update stored trail
          elephantPathsRef.current.set(elephantId, finalTrail);
          
          console.log(`🐘 Trail built for ${elephantId}: ${finalTrail.length} points (static: ${!frameBasedData && !!trackingData})`);
          
          // Get current position (last point)
          const currentObj = elephantObjects[elephantObjects.length - 1];
          const currentCoords = localToLatLng(currentObj.x, currentObj.y);
          const currentPoint = [currentCoords.lat, currentCoords.lng] as [number, number];

          // Compute boundary status relative to multiple circles (or single fallback)
          let isOutsideCombined = true;
          let currentInsideSet = new Set<string>();
          if (boundaryCircles && boundaryCircles.length > 0) {
            for (const bc of boundaryCircles) {
              const dLatM = (currentCoords.lat - bc.center.lat) * 111320;
              const dLngM = (currentCoords.lng - bc.center.lng) * 111320 * Math.cos(bc.center.lat * Math.PI / 180);
              const dist = Math.sqrt(dLatM * dLatM + dLngM * dLngM);
              if (dist <= bc.radius) {
                isOutsideCombined = false;
                currentInsideSet.add(bc.id);
              }
            }
          } else {
            const c = boundaryCenterLatLng || referencePoint;
            const dLatM = (currentCoords.lat - c.lat) * 111320;
            const dLngM = (currentCoords.lng - c.lng) * 111320 * Math.cos(c.lat * Math.PI / 180);
            const dist = Math.sqrt(dLatM * dLatM + dLngM * dLngM);
            isOutsideCombined = dist > boundaryRadiusMeters;
          }
          
          // Check boundary violation and notify
          if (onBoundaryViolation) {
            // Debug logging
            console.log(`🐘 ${elephantId}: latlng(${currentCoords.lat.toFixed(6)}, ${currentCoords.lng.toFixed(6)}) -> outside: ${isOutsideCombined}`);
            onBoundaryViolation(elephantId, isOutsideCombined, { x: currentObj.x, y: currentObj.y });

            // Detect and notify circle entries (only in multi-circle mode)
            if (boundaryCircles && boundaryCircles.length > 0) {
              const prevInside = elephantInsideCirclesRef.current.get(elephantId) || new Set<string>();
              const newlyEntered: string[] = [];
              currentInsideSet.forEach((cid) => { if (!prevInside.has(cid)) newlyEntered.push(cid); });
              elephantInsideCirclesRef.current.set(elephantId, currentInsideSet);
              if (newlyEntered.length > 0 && typeof onCircleEntry === 'function') {
                newlyEntered.forEach(cid => onCircleEntry(elephantId, cid));
              }
            }
          }
          
          // Update position for E1 and E2 tracking
          if (onPositionUpdate) {
            onPositionUpdate(elephantId, { x: currentObj.x, y: currentObj.y }, currentObj.timestamp);
          }
          
          // Remove existing trail for this elephant
          if (elephantTrailsRef.current.has(elephantId) && mapRef.current) {
            mapRef.current.removeLayer(elephantTrailsRef.current.get(elephantId)!);
          }

          // Create new trail for this elephant with unique color (only if >= 2 points)
          const trailColors = ['#ff0000', '#0066ff', '#00ff00', '#ff6600', '#9900ff'];
          // Use hash of elephant ID for consistent color assignment
          const colorIndex = elephantId.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0) % trailColors.length;
          const trailColor = trailColors[colorIndex];
          
          if (!mapRef.current) return;
          // Clean trail: remove any points close to the reference point and collapse duplicates
          const refLat = referencePoint.lat;
          const refLng = referencePoint.lng;
          // reuse centerSkipLat/centerSkipLng thresholds computed earlier where we filtered objects
          const cleanedTrail: [number, number][] = [];
          for (const [lat, lng] of finalTrail) {
            const isNearCenter = Math.abs(lat - refLat) < centerSkipLat && Math.abs(lng - refLng) < centerSkipLng;
            if (isNearCenter) continue;
            const last = cleanedTrail[cleanedTrail.length - 1];
            const isDup = last && Math.abs(last[0] - lat) < 1e-7 && Math.abs(last[1] - lng) < 1e-7;
            if (!isDup) cleanedTrail.push([lat, lng]);
          }

          if (cleanedTrail.length >= 2) {
            const elephantPolyline = L.polyline(cleanedTrail, {
              color: trailColor,
              weight: 4,
              opacity: 0.8,
              lineCap: 'round',
              lineJoin: 'round'
            }).addTo(mapRef.current);
            elephantPolyline.bindPopup(`🐘 Elephant ${elephantId} Trail (${cleanedTrail.length} points)`);
            elephantTrailsRef.current.set(elephantId, elephantPolyline);
          } else {
            // No trail to draw yet
            elephantTrailsRef.current.delete(elephantId);
          }

          // Create/update marker for this elephant using computed boundary status
          const elephantIsOutside = isOutsideCombined;

          const elephantColor = elephantIsOutside ? '🔴' : '🐘';
          const markerColor = elephantIsOutside ? '#ff0000' : trailColor;
          
          const elephantIcon = L.divIcon({
            className: 'elephant-marker',
            html: `<div style="font-size: 24px; text-align: center; line-height: 1; color: ${markerColor}; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); font-weight: bold;">${elephantColor}</div>`,
            iconSize: [30, 30],
            iconAnchor: [15, 15],
          });

          const popupText = elephantIsOutside 
            ? `🚨 ALERT: Elephant ${elephantId} OUTSIDE boundary - Objects: ${visibleObjectCount}/${currentData.objects.length} (Trail: ${finalTrail.length} pts)`
            : `🐘 Elephant ${elephantId} INSIDE boundary - Objects: ${visibleObjectCount}/${currentData.objects.length} (Trail: ${finalTrail.length} pts)`;

          // Remove existing marker for this elephant
          if (elephantMarkersRef.current.has(elephantId) && mapRef.current) {
            mapRef.current.removeLayer(elephantMarkersRef.current.get(elephantId)!);
          }

          // Create new marker for this elephant
          if (!mapRef.current) return;
          
          const elephantMarker = L.marker(currentPoint, { icon: elephantIcon })
            .addTo(mapRef.current)
            .bindPopup(popupText);
          
          elephantMarkersRef.current.set(elephantId, elephantMarker);

          // Create a static start marker for this elephant (only once and when trail has at least one point)
          if (!elephantStartMarkersRef.current.has(elephantId) && cleanedTrail.length > 0) {
            const startPoint = cleanedTrail[0];
            const startMarker = L.marker(startPoint)
              .addTo(mapRef.current)
              .bindPopup(`📍 ${elephantId} Start`);
            elephantStartMarkersRef.current.set(elephantId, startMarker);
          }
          
          console.log(`🐘 Elephant ${elephantId} updated:`, elephantIsOutside ? 'OUTSIDE' : 'inside', `with ${finalTrail.length} trail points`);
        });

        // 6. Fit bounds based on controls
        const shouldManualFit = typeof fitNowVersion === 'number' && fitNowVersion !== lastFitNowVersionRef.current;
        const shouldAutoFit = autoFitEnabled;
        const allowOnceFit = !isRealTime && !hasFitBoundsRef.current;
        if (allowOnceFit || shouldAutoFit || shouldManualFit) {
          const boundCoords: [number, number][] = [];
          elephantPathsRef.current.forEach((path) => {
            boundCoords.push(...path);
          });
          if (boundCoords.length === 0) {
            boundCoords.push([referencePoint.lat, referencePoint.lng]);
          }
          const group = L.featureGroup(boundCoords.map(coord => L.marker(coord)));
          mapRef.current.fitBounds(group.getBounds().pad(0.1));
          hasFitBoundsRef.current = true;
          if (shouldManualFit) {
            lastFitNowVersionRef.current = fitNowVersion;
          }
        }
        
        console.log(`✅ UPDATED: Multi-elephant tracking (${elephantGroups.size} elephants), Objects: ${visibleObjectCount}`);
      }

    } catch (error: any) {
      console.error('Error updating tracking data:', error);
    }
    // After updates, make sure Leaflet recalculates size in case layout changed
    if (mapRef.current) {
      setTimeout(() => {
        mapRef.current && mapRef.current.invalidateSize();
      }, 0);
    }
  }, [trackingData, frameBasedData, isAnimating, currentPointIndex, boundaryData, elephantsInBoundary, boundaryRadiusMeters, isRealTime]);

  return (
    <>
      {/* Add CSS for animations */}
      <style>{`
        @keyframes pulse {
          0% { transform: scale(1); }
          50% { transform: scale(1.2); }
          100% { transform: scale(1); }
        }
        
        .elephant-marker {
          transition: all 0.3s ease-in-out;
        }
      `}</style>
      
      <div style={{ position: 'relative', width: '100%', height: '100vh' }}>
        <div ref={mapContainerRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0 }} />
        
        {/* Enhanced Info Panel */}
        <div style={{
          position: 'absolute',
          top: '20px',
          left: '20px',
          background: 'rgba(255, 255, 255, 0.95)',
          padding: '16px',
          borderRadius: '8px',
          boxShadow: '0 2px 10px rgba(0, 0, 0, 0.1)',
          zIndex: 1000,
          maxWidth: '320px'
        }}>
          <h2 style={{ fontSize: '18px', fontWeight: 'bold', color: isRealTime ? '#dc2626' : '#2563eb', marginBottom: '8px' }}>
            {isRealTime ? '� Real-time Tracking' : '🐘 Elephant Tracking'}
          </h2>
          <p style={{ fontSize: '14px', color: '#6b7280', marginBottom: '8px' }}>
            {isRealTime ? 'Live elephant detection from video feed' : 'Watch the elephant\'s journey unfold!'}
          </p>
          
          {(trackingData || frameBasedData) && (
            <div>
              <p style={{ fontSize: '12px', color: '#10b981', margin: '4px 0' }}>
                📊 Total Data: {trackingData?.objects?.length || frameBasedData?.frames?.length || 0}
              </p>
              {isAnimating && (
                <div>
                  <p style={{ fontSize: '12px', color: '#ff6b35', margin: '4px 0', fontWeight: 'bold' }}>
                    🎬 Progress: {currentPointIndex + 1} / {trackingData?.objects?.length || frameBasedData?.frames?.length || 0}
                  </p>
                  <div style={{ 
                    width: '100%', 
                    height: '4px', 
                    backgroundColor: '#e2e8f0', 
                    borderRadius: '2px',
                    marginTop: '8px',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      width: `${((currentPointIndex + 1) / (trackingData?.objects?.length || frameBasedData?.frames?.length || 1)) * 100}%`,
                      height: '100%',
                      backgroundColor: '#ff6b35',
                      borderRadius: '2px',
                      transition: 'width 0.3s ease-in-out'
                    }} />
                  </div>
                </div>
              )}
              <div style={{ fontSize: '11px', color: '#64748b', marginTop: '8px' }}>
                <div>� Green Circle: Boundary Radius</div>
                <div>🎨 Colored Trails: Per-Elephant Paths</div>
                <div>🏁 Start Markers: Initial Positions</div>
                <div>🐘 Current: Live Elephant Positions</div>
                <div>🔴 Red Alert: Boundary Violations</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default SimpleMap;