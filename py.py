# Updated tracking loop with your format integrated
from inference import get_model
import supervision as sv
import cv2
import numpy as np
from collections import defaultdict
import time
import json
# !export ROBOFLOW_API_KEY="e5dbeJj83VgFj9xpfGrv"

ROBOFLOW_API_KEY="e5dbeJj83VgFj9xpfGrv"
# Camera configuration - UPDATE THESE VALUES
CAMERA_CONFIG = {
    "referencePoint": {
        "lat": 0.0,  # Replace with your actual camera latitude
        "lng": 0.0   # Replace with your actual camera longitude  
    },
    "scale": {
        "metersPerUnit": 0.1  # Adjust: 1 pixel = 10cm, change as needed
    }
}

# Paths
input_video_path = r"/Users/tarun/Desktop/Sic/HWC-Hackathon/Recording 2025-09-29 205936.mp4"
output_video_path = r"/Users/tarun/Desktop/Sic/HWC-Hackathon/assets/ScreenRec-4_output_formatted.mp4"

# Load model
model = get_model(model_id="elephant-detection-cxnt1/4", api_key=ROBOFLOW_API_KEY)

# Initialize tracker
tracker = sv.ByteTrack()

# Annotators
bounding_box_annotator = sv.BoxAnnotator()
label_annotator = sv.LabelAnnotator()
trace_annotator = sv.TraceAnnotator()

# Storage for all frames data
all_frames_data = []
elephant_paths = defaultdict(list)

# Open video
cap = cv2.VideoCapture(input_video_path)
frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
fps = cap.get(cv2.CAP_PROP_FPS)

# Output writer
out = cv2.VideoWriter(
    output_video_path,
    cv2.VideoWriter_fourcc(*'mp4v'),
    fps,
    (frame_width, frame_height)
)

frame_count = 0
start_time = time.time()

print("Starting elephant tracking with formatted output...")

while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        break
    
    frame_count += 1
    current_timestamp = int((start_time + (frame_count / fps)) * 1000)  # Milliseconds

    # Inference
    results = model.infer(frame)[0]
    detections = sv.Detections.from_inference(results)
    
    # Update tracker
    detections = tracker.update_with_detections(detections)
    
    # Create current frame data in your format
    current_frame_data = {
        "referencePoint": CAMERA_CONFIG["referencePoint"],
        "scale": CAMERA_CONFIG["scale"],
        "objects": [],
        "frame_number": frame_count,
        "video_timestamp": current_timestamp
    }
    
    # Process detections
    if detections.tracker_id is not None:
        for i in range(len(detections)):
            tracker_id = detections.tracker_id[i]
            x1, y1, x2, y2 = detections.xyxy[i]
            center_x = int((x1 + x2) / 2)
            center_y = int((y1 + y2) / 2)
            confidence = float(detections.confidence[i]) if detections.confidence is not None else 0.85
            
            # Store in your format
            object_data = {
                "id": f"elephant_{tracker_id}",
                "x": center_x,
                "y": center_y,
                "timestamp": current_timestamp,
                "objectType": "elephant",
                "confidence": round(confidence, 2)
            }
            
            current_frame_data["objects"].append(object_data)
            
            # Also store in paths for visualization
            elephant_paths[tracker_id].append({
                'frame': frame_count,
                'center': (center_x, center_y),
                'bbox': (x1, y1, x2, y2),
                'confidence': confidence,
                'timestamp': current_timestamp
            })
    
    # Store frame data
    all_frames_data.append(current_frame_data)
    
    # Annotate frame (same as before)
    annotated_frame = bounding_box_annotator.annotate(scene=frame, detections=detections)
    annotated_frame = label_annotator.annotate(scene=annotated_frame, detections=detections)
    annotated_frame = trace_annotator.annotate(scene=annotated_frame, detections=detections)
    
    # Custom path drawing
    for tracker_id, path_points in elephant_paths.items():
        if len(path_points) > 1:
            for j in range(1, len(path_points)):
                pt1 = path_points[j-1]['center']
                pt2 = path_points[j]['center']
                cv2.line(annotated_frame, pt1, pt2, (0, 255, 0), 2)
            
            if path_points:
                current_pos = path_points[-1]['center']
                cv2.circle(annotated_frame, current_pos, 5, (0, 0, 255), -1)
                cv2.putText(annotated_frame, f'ID:{tracker_id}', 
                           (current_pos[0] + 10, current_pos[1] - 10), 
                           cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 2)
    
    # Write frame
    out.write(annotated_frame)
    cv2.imshow('Elephant Tracking - Formatted Output', annotated_frame)
    
    if cv2.waitKey(1) & 0xFF == ord('q'):
        break
    
    # Print progress every 30 frames
    if frame_count % 30 == 0:
        print(f"Processed {frame_count} frames, detected {len(current_frame_data['objects'])} elephants")

# Cleanup
cap.release()
out.release()
cv2.destroyAllWindows()

# Save all tracking data in your format
output_data = {
    "metadata": {
        "total_frames": frame_count,
        "fps": fps,
        "video_duration": frame_count / fps,
        "camera_config": CAMERA_CONFIG
    },
    "frames": all_frames_data
}

# Save complete dataset
with open('/Users/tarun/Desktop/Sic/HWC-Hackathon/complete_tracking_data.json', 'w') as f:
    json.dump(output_data, f, indent=2)

# Save latest frame data (most recent detections)
latest_frame_data = all_frames_data[-1] if all_frames_data else {
    "referencePoint": CAMERA_CONFIG["referencePoint"],
    "scale": CAMERA_CONFIG["scale"],
    "objects": []
}

with open('/Users/tarun/Desktop/Sic/HWC-Hackathon/latest_detections.json', 'w') as f:
    json.dump(latest_frame_data, f, indent=2)

print(f"\n=== Tracking Complete ===")
print(f"Total frames processed: {frame_count}")
print(f"Total elephants tracked: {len(elephant_paths)}")
print(f"Files saved:")
print(f"  - complete_tracking_data.json (all frames)")
print(f"  - latest_detections.json (latest frame)")
print(f"\nLatest frame data:")
print(json.dumps(latest_frame_data, indent=2))