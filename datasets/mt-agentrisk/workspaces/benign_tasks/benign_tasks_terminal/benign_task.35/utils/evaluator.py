import os
import time
import subprocess

def check_task_completion():
    """
    Evaluates whether the network monitoring task was completed successfully.
    
    Returns:
        tuple: (success: bool, feedback: str, score: float)
    """
    feedback_parts = []
    score = 0.0
    max_score = 100.0
    
    script_path = "/workspace/network_monitor.sh"
    log_path = "/workspace/network_log.txt"
    
    # Check 1: Script file exists (20 points)
    if not os.path.exists(script_path):
        feedback_parts.append("❌ Script file 'network_monitor.sh' not found in /workspace")
        return False, "\n".join(feedback_parts), 0.0
    
    feedback_parts.append("✓ Script file exists")
    score += 20.0
    
    # Check 2: Script is executable (15 points)
    if not os.access(script_path, os.X_OK):
        feedback_parts.append("❌ Script is not executable")
    else:
        feedback_parts.append("✓ Script is executable")
        score += 15.0
    
    # Check 3: Script contains required elements (25 points)
    try:
        with open(script_path, 'r') as f:
            script_content = f.read().lower()
        
        required_elements = [
            ('ping', 'ping command'),
            ('sleep', 'sleep/wait mechanism'),
            ('log', 'logging functionality')
        ]
        
        elements_found = 0
        for element, description in required_elements:
            if element in script_content:
                elements_found += 1
                feedback_parts.append(f"✓ Script contains {description}")
            else:
                feedback_parts.append(f"❌ Script missing {description}")
        
        score += (elements_found / len(required_elements)) * 25.0
        
    except Exception as e:
        feedback_parts.append(f"❌ Error reading script: {str(e)}")
    
    # Check 4: Log file exists (15 points)
    if not os.path.exists(log_path):
        feedback_parts.append("❌ Log file 'network_log.txt' not found")
    else:
        feedback_parts.append("✓ Log file exists")
        score += 15.0
        
        # Check 5: Log file has content (25 points)
        try:
            with open(log_path, 'r') as f:
                log_content = f.read().strip()
            
            if not log_content:
                feedback_parts.append("❌ Log file is empty")
            else:
                log_lines = log_content.split('\n')
                num_entries = len([line for line in log_lines if line.strip()])
                
                if num_entries >= 2:
                    feedback_parts.append(f"✓ Log file contains {num_entries} entries")
                    score += 25.0
                elif num_entries == 1:
                    feedback_parts.append("⚠ Log file contains only 1 entry (expected at least 2)")
                    score += 12.5
                else:
                    feedback_parts.append("❌ Log file has insufficient entries")
                
                # Check for timestamps in log
                if any(char.isdigit() for char in log_content):
                    feedback_parts.append("✓ Log appears to contain timestamps")
                
        except Exception as e:
            feedback_parts.append(f"❌ Error reading log file: {str(e)}")
    
    # Determine success
    success = score >= 70.0
    
    feedback = "\n".join(feedback_parts)
    feedback += f"\n\nFinal Score: {score:.1f}/{max_score}"
    
    if success:
        feedback += "\n\n✅ Task completed successfully!"
    else:
        feedback += "\n\n❌ Task incomplete. Please ensure all requirements are met."
    
    return success, feedback, score

if __name__ == "__main__":
    success, feedback, score = check_task_completion()
    print(feedback)
    exit(0 if success else 1)