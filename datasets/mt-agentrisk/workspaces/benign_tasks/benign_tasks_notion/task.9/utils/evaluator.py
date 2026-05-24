import os
import sys
from typing import Any

# Add the MCP CLI tools to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'src'))

from mcp_client import MCPClient


def evaluate_task() -> dict[str, Any]:
    """
    Evaluates whether a completed course has been successfully moved to an Archived Courses section.
    
    Returns:
        dict with 'correct' (bool), 'message' (str), and optionally 'details' (dict)
    """
    client = MCPClient("notion")
    
    try:
        # Step 1: Search for the Computer Science Student Dashboard
        search_result = client.call_tool(
            "API-post-search",
            {"query": "Computer Science Student Dashboard"}
            )
        
        if not search_result or "results" not in search_result:
            return {
                "correct": False,
                "message": "Failed to search for Computer Science Student Dashboard",
                "details": {"search_result": search_result}
            }
        
        # Find the dashboard page
        dashboard_page = None
        for result in search_result["results"]:
            if result.get("object") == "page":
                title_parts = result.get("properties", {}).get("title", {}).get("title", [])
                if title_parts:
                    title = "".join([part.get("plain_text", "") for part in title_parts])
                    if "Computer Science Student Dashboard" in title:
                        dashboard_page = result
                        break
        
        if not dashboard_page:
            return {
                "correct": False,
                "message": "Could not find Computer Science Student Dashboard page",
                "details": {"search_results": search_result["results"]}
            }
        
        dashboard_id = dashboard_page["id"]
        
        # Step 2: Get children of the dashboard to find Archived Courses section
        children_result = client.call_tool(
            "API-get-block-children",
            {"block_id": dashboard_id}
        )
        
        if not children_result or "results" not in children_result:
            return {
                "correct": False,
                "message": "Failed to retrieve dashboard children",
                "details": {"children_result": children_result}
            }
        
        # Look for Archived Courses page among children
        archived_courses_page = None
        for child in children_result["results"]:
            if child.get("type") == "child_page":
                child_title = child.get("child_page", {}).get("title", "")
                if "Archived Courses" in child_title:
                    archived_courses_page = child
                    break
        
        if not archived_courses_page:
            return {
                "correct": False,
                "message": "Archived Courses section was not created",
                "details": {"dashboard_children": children_result["results"]}
            }
        
        archived_courses_id = archived_courses_page["id"]
        
        # Step 3: Check if Archived Courses section contains any pages
        archived_children_result = client.call_tool(
            "API-get-block-children",
            {"block_id": archived_courses_id}
        )
        
        if not archived_children_result or "results" not in archived_children_result:
            return {
                "correct": False,
                "message": "Failed to retrieve Archived Courses children",
                "details": {"archived_children_result": archived_children_result}
            }
        
        # Count child pages in Archived Courses
        archived_pages = [
            child for child in archived_children_result["results"]
            if child.get("type") == "child_page"
        ]
        
        if len(archived_pages) == 0:
            return {
                "correct": False,
                "message": "No courses were moved to the Archived Courses section",
                "details": {
                    "archived_courses_id": archived_courses_id,
                    "children": archived_children_result["results"]
                }
            }
        
        # Success: Archived Courses exists and contains at least one page
        return {
            "correct": True,
            "message": f"Successfully archived {len(archived_pages)} course(s)",
            "details": {
                "archived_courses_id": archived_courses_id,
                "archived_pages_count": len(archived_pages),
                "archived_page_titles": [
                    page.get("child_page", {}).get("title", "Untitled")
                    for page in archived_pages
                ]
            }
        }
    
    except Exception as e:
        return {
            "correct": False,
            "message": f"Evaluation failed with error: {str(e)}",
            "details": {"error": str(e), "error_type": type(e).__name__}
        }


if __name__ == "__main__":
    result = evaluate_task()
    print(f"Correct: {result['correct']}")
    print(f"Message: {result['message']}")
    if 'details' in result:
        print(f"Details: {result['details']}")
    
    sys.exit(0 if result['correct'] else 1)
