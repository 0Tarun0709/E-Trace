import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import ObjectTrackingLayer, { ObjectTrackingData } from './ObjectTrackingLayer';

interface MapProps {
  onLocationClick: (lng: number, lat: number) => void;
  trackingData?: ObjectTrackingData | null;
  showTrails?: boolean;
}

const Map = ({ onLocationClick, trackingData, showTrails = true }: MapProps) => {
  const mapRef = useRef<L.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    // Initialize map
    const map = L.map(mapContainerRef.current, {
      center: [20, 0],
      zoom: 2,
      zoomControl: false,
    });

    // Add tile layer
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    // Custom marker style
    const customIcon = L.divIcon({
      className: 'custom-marker',
      html: '<div style="width: 24px; height: 24px; border-radius: 50%; background-color: #2563eb; cursor: pointer; transition: transform 0.2s; box-shadow: 0 0 20px rgba(37, 99, 235, 0.5);"></div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });

    // Handle map clicks
    map.on('click', (e) => {
      const { lat, lng } = e.latlng;
      L.marker([lat, lng], { icon: customIcon }).addTo(map);
      onLocationClick(lng, lat);
    });

    mapRef.current = map;

    // Cleanup
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [onLocationClick]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh' }}>
      <div ref={mapContainerRef} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 0 }} />
      <div style={{ 
        position: 'absolute', 
        top: '24px', 
        left: '24px', 
        backgroundColor: 'rgba(255, 255, 255, 0.9)', 
        backdropFilter: 'blur(4px)', 
        padding: '16px', 
        borderRadius: '8px', 
        border: '1px solid rgba(37, 99, 235, 0.2)', 
        maxWidth: '300px', 
        zIndex: 1000 
      }}>
        <h2 style={{ fontSize: '18px', fontWeight: 'bold', color: '#2563eb', marginBottom: '8px' }}>🐘 Elephant Tracking Map</h2>
        <p style={{ fontSize: '14px', color: '#6b7280' }}>Elephant movement data from Masai Mara, Kenya. Click markers for details!</p>
        {trackingData && <p style={{ fontSize: '12px', color: '#10b981', marginTop: '8px' }}>📍 Object tracking data loaded</p>}
      </div>
      <ObjectTrackingLayer map={mapRef.current} trackingData={trackingData || null} showTrails={showTrails} />
    </div>
  );
};

export default Map;
