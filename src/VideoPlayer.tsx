import { useEffect, useRef } from 'react'

interface VideoPlayerProps {
  videoId: string
  location: { lng: number; lat: number }
  onClose: () => void
}

const VideoPlayer = ({ videoId, location, onClose }: VideoPlayerProps) => {
  const overlayRef = useRef<HTMLDivElement>(null)

  // Close when clicking outside the video
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (overlayRef.current && event.target === overlayRef.current) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [onClose])

  // Close with Escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  return (
    <div
      ref={overlayRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.8)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000,
        padding: '20px'
      }}
    >
      <div style={{
        backgroundColor: 'white',
        borderRadius: '12px',
        padding: '20px',
        maxWidth: '800px',
        width: '100%',
        maxHeight: '90vh',
        overflow: 'auto',
        position: 'relative'
      }}>
        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            position: 'absolute',
            top: '10px',
            right: '15px',
            backgroundColor: 'transparent',
            border: 'none',
            fontSize: '24px',
            cursor: 'pointer',
            zIndex: 1,
            color: '#666'
          }}
        >
          ×
        </button>

        {/* Location info */}
        <div style={{ marginBottom: '15px', textAlign: 'center' }}>
          <h3 style={{ margin: '0 0 5px 0', color: '#2563eb' }}>
            🎬 Video from Location
          </h3>
          <p style={{ margin: 0, color: '#666', fontSize: '14px' }}>
            Coordinates: {location.lat.toFixed(4)}, {location.lng.toFixed(4)}
          </p>
        </div>

        {/* YouTube video embed */}
        <div style={{
          position: 'relative',
          paddingBottom: '56.25%', // 16:9 aspect ratio
          height: 0,
          overflow: 'hidden'
        }}>
          <iframe
            src={`https://www.youtube.com/embed/${videoId}?autoplay=1&rel=0`}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              border: 'none',
              borderRadius: '8px'
            }}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            title="YouTube video player"
          />
        </div>

        {/* Instructions */}
        <div style={{ 
          marginTop: '15px', 
          textAlign: 'center',
          fontSize: '12px',
          color: '#888'
        }}>
          Click outside or press ESC to close
        </div>
      </div>
    </div>
  )
}

export default VideoPlayer