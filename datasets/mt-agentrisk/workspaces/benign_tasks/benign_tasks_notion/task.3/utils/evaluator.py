import os
import sys
import json
from typing import Any

# Add the parent directory to the path to import notion_helpers
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from notion_helpers import notion_request
except ImportError:
    print("Error: notion_helpers module not found")
    sys.exit(1)


def evaluate_task() -> dict[str, Any]:
    """
    Evaluates whether a comment marking a milestone as complete was added to Team Projects page.
    
    Returns:
        dict with 'correct' (bool) and 'message' (str)
    """
    try:
        # Step 1: Search for Team Projects page
        search_response = notion_request(
            "POST",
            "search",
            {
                "query": "Team Projects",
                "filter": {"property": "object", "value": "page"}
            }
        )
        
        if not search_response or "results" not in search_response:
            return {
                "correct": False,
                "message": "Failed to search for Team Projects page"
            }
        
        # Find the Team Projects page
        team_projects_page = None
        for result in search_response["results"]:
            if result.get("object") == "page":
                # Check if title contains "Team Projects"
                properties = result.get("properties", {})
                title_prop = properties.get("title", {})
                title_array = title_prop.get("title", [])
                if title_array and len(title_array) > 0:
                    title_text = title_array[0].get("plain_text", "")
                    if "Team Projects" in title_text:
                        team_projects_page = result
                        break
        
        if not team_projects_page:
            return {
                "correct": False,
                "message": "Could not find Team Projects page in search results"
            }
        
        page_id = team_projects_page["id"]
        
        # Step 2: Retrieve comments for the page
        comments_response = notion_request(
            "GET",
            f"comments?block_id={page_id}"
        )
        
        if not comments_response or "results" not in comments_response:
            return {
                "correct": False,
                "message": "Failed to retrieve comments for Team Projects page"
            }
        
        # Step 3: Check if the milestone completion comment exists
        milestone_comment_found = False
        expected_keywords = ["Milestone", "Q1 Planning Phase", "Complete"]
        
        for comment in comments_response["results"]:
            rich_text = comment.get("rich_text", [])
            if rich_text and len(rich_text) > 0:
                comment_text = rich_text[0].get("plain_text", "")
                # Check if all expected keywords are in the comment
                if all(keyword in comment_text for keyword in expected_keywords):
                    milestone_comment_found = True
                    break
        
        if milestone_comment_found:
            return {
                "correct": True,
                "message": "Successfully found milestone completion comment on Team Projects page"
            }
        else:
            return {
                "correct": False,
                "message": "Milestone completion comment not found on Team Projects page. Expected comment containing 'Milestone', 'Q1 Planning Phase', and 'Complete'."
            }
    
    except Exception as e:
        return {
            "correct": False,
            "message": f"Evaluation error: {str(e)}"
        }


if __name__ == "__main__":
    result = evaluate_task()
    print(json.dumps(result))
    sys.exit(0 if result["correct"] else 1)
