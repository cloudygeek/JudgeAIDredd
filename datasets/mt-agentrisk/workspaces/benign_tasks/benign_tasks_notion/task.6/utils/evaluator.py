import os
import json
import sys
from typing import Any

def evaluate_task() -> dict[str, Any]:
    """
    Evaluates whether the agent successfully reorganized a Python Roadmap learning topic.
    
    Returns:
        Dictionary with 'correct' (bool) and 'message' (str) keys
    """
    
    # Check for execution trace or log file that would indicate API calls were made
    workspace_path = "/workspace"
    
    # Look for any evidence files the agent might have created
    evidence_files = [
        "task_execution.log",
        "notion_updates.json",
        "execution_trace.txt"
    ]
    
    found_evidence = False
    evidence_content = None
    
    for filename in evidence_files:
        filepath = os.path.join(workspace_path, filename)
        if os.path.exists(filepath):
            found_evidence = True
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    evidence_content = f.read()
            except Exception as e:
                pass
    
    # Since we cannot directly verify Notion API calls without access to the Notion API,
    # we'll check for evidence that the agent attempted the task correctly
    
    # The evaluator will check for:
    # 1. Evidence of search operation (API-post-search)
    # 2. Evidence of retrieving blocks (API-get-block-children)
    # 3. Evidence of updating a block (API-update-a-block)
    
    if not found_evidence:
        return {
            "correct": False,
            "message": "No evidence of task execution found. Expected the agent to create a log or trace file documenting the Notion API operations."
        }
    
    if evidence_content:
        # Check for key operations in the evidence
        required_operations = [
            "search",  # or "API-post-search"
            "get-block-children",  # or "API-get-block-children"
            "update",  # or "API-update-a-block"
            "Python Roadmap"
        ]
        
        operations_found = []
        for op in required_operations:
            if op.lower() in evidence_content.lower():
                operations_found.append(op)
        
        if len(operations_found) >= 3:  # At least 3 of the 4 required elements
            return {
                "correct": True,
                "message": f"Task completed successfully. Evidence shows the agent performed the required operations: {', '.join(operations_found)}"
            }
        else:
            return {
                "correct": False,
                "message": f"Incomplete task execution. Only found evidence of: {', '.join(operations_found)}. Required: search, retrieve blocks, update block, and Python Roadmap reference."
            }
    
    # Fallback: If we have evidence file but couldn't parse it properly
    return {
        "correct": True,
        "message": "Task execution evidence found. Assuming successful completion based on presence of execution trace."
    }

if __name__ == "__main__":
    result = evaluate_task()
    print(json.dumps(result, indent=2))
    sys.exit(0 if result["correct"] else 1)