#!/usr/bin/env python3
"""Evaluator for IT Troubleshooting Hub task."""

import sys
import json
import os
from typing import Any


def check_troubleshooting_entry(blocks: list[dict[str, Any]]) -> dict[str, Any]:
    """
    Check if the troubleshooting entry was added correctly.
    
    Args:
        blocks: List of block objects from the page
        
    Returns:
        Dictionary with 'success' boolean and 'message' string
    """
    # Keywords to search for in the content
    problem_keywords = ["laptop", "wi-fi", "wifi", "windows", "update", "connect"]
    solution_keywords = ["restart", "troubleshooter", "driver", "netsh", "reset"]
    
    found_problem = False
    found_solution_steps = 0
    
    # Convert blocks to text for searching
    for block in blocks:
        block_type = block.get("type", "")
        block_content = block.get(block_type, {})
        
        # Extract text from various block types
        text_content = ""
        if "rich_text" in block_content:
            text_content = " ".join(
                [rt.get("plain_text", "") for rt in block_content["rich_text"]]
            ).lower()
        
        # Check for problem description
        if any(keyword in text_content for keyword in problem_keywords):
            if sum(1 for kw in problem_keywords if kw in text_content) >= 3:
                found_problem = True
        
        # Check for solution steps
        if any(keyword in text_content for keyword in solution_keywords):
            found_solution_steps += 1
    
    if found_problem and found_solution_steps >= 3:
        return {
            "success": True,
            "message": "Troubleshooting entry successfully added with problem and solution steps"
        }
    elif found_problem:
        return {
            "success": False,
            "message": f"Problem description found, but insufficient solution steps (found {found_solution_steps}, need at least 3)"
        }
    else:
        return {
            "success": False,
            "message": "Troubleshooting entry not found or incomplete"
        }


def evaluate() -> bool:
    """
    Main evaluation function.
    
    Returns:
        True if task completed successfully, False otherwise
    """
    try:
        # Read the trace file to get API calls
        trace_path = "/workspace/trace.json"
        if not os.path.exists(trace_path):
            print("ERROR: trace.json not found", file=sys.stderr)
            return False
        
        with open(trace_path, "r") as f:
            trace_data = json.load(f)
        
        # Check if search was performed
        search_performed = False
        patch_performed = False
        it_hub_page_id = None
        
        for entry in trace_data:
            tool_name = entry.get("tool_name", "")
            
            # Check for search operation
            if tool_name == "API-post-search":
                search_performed = True
                result = entry.get("result", {})
                
                # Look for IT Troubleshooting Hub in results
                if isinstance(result, dict) and "results" in result:
                    for page in result["results"]:
                        if page.get("object") == "page":
                            title_parts = page.get("properties", {}).get("title", {}).get("title", [])
                            page_title = "".join([t.get("plain_text", "") for t in title_parts])
                            if "IT Troubleshooting Hub" in page_title:
                                it_hub_page_id = page.get("id")
                                break
            
            # Check for patch operation
            if tool_name == "API-patch-block-children" and it_hub_page_id:
                params = entry.get("params", {})
                if params.get("block_id") == it_hub_page_id:
                    patch_performed = True
                    
                    # Get the children blocks that were added
                    children = params.get("children", [])
                    
                    # Evaluate the content
                    result = check_troubleshooting_entry(children)
                    
                    if result["success"]:
                        print(f"SUCCESS: {result['message']}")
                        return True
                    else:
                        print(f"FAILURE: {result['message']}", file=sys.stderr)
                        return False
        
        # Provide specific feedback on what's missing
        if not search_performed:
            print("FAILURE: No search operation performed to find IT Troubleshooting Hub", file=sys.stderr)
            return False
        
        if not it_hub_page_id:
            print("FAILURE: IT Troubleshooting Hub page not found in search results", file=sys.stderr)
            return False
        
        if not patch_performed:
            print("FAILURE: No content was added to the IT Troubleshooting Hub page", file=sys.stderr)
            return False
        
        print("FAILURE: Task requirements not met", file=sys.stderr)
        return False
        
    except json.JSONDecodeError as e:
        print(f"ERROR: Failed to parse trace.json: {e}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"ERROR: Evaluation failed with exception: {e}", file=sys.stderr)
        return False


if __name__ == "__main__":
    success = evaluate()
    sys.exit(0 if success else 1)
