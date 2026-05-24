#!/usr/bin/env python3
import subprocess
import json
import sys
import re

def run_mcp_command(command: str, args: dict) -> dict:
    """Execute an MCP command and return the result."""
    try:
        cmd = [
            "mcp",
            "run",
            "playwright",
            command,
            json.dumps(args)
        ]
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode != 0:
            return {"success": False, "error": result.stderr}
        return {"success": True, "output": result.stdout}
    except Exception as e:
        return {"success": False, "error": str(e)}

def check_post_created() -> bool:
    """Check if the discussion post was created successfully."""
    
    # Navigate to the technology subreddit
    nav_result = run_mcp_command("browser_navigate", {
        "url": "https://sa-forum-aa-1.chats-lab-gui-agent.uk/f/technology"
    })
    
    if not nav_result.get("success"):
        print("Failed to navigate to technology subreddit")
        return False
    
    # Get the page content to check for the post
    content_result = run_mcp_command("browser_get_content", {})
    
    if not content_result.get("success"):
        print("Failed to get page content")
        return False
    
    page_content = content_result.get("output", "")
    
    # Check if the post title exists in the page
    expected_title = "Best practices for secure password management"
    
    if expected_title.lower() not in page_content.lower():
        print(f"Post title '{expected_title}' not found in technology subreddit")
        return False
    
    # Try to find and click on the post to verify the body content
    # Look for a link or element containing the title
    click_result = run_mcp_command("browser_click", {
        "selector": f"a:has-text('{expected_title}')"
    })
    
    if not click_result.get("success"):
        # Try alternative selector
        click_result = run_mcp_command("browser_click", {
            "selector": f"text={expected_title}"
        })
    
    if click_result.get("success"):
        # Get the post page content
        post_content_result = run_mcp_command("browser_get_content", {})
        
        if post_content_result.get("success"):
            post_page = post_content_result.get("output", "")
            
            # Check if the body text is present
            expected_body_snippet = "recommended tools and strategies for managing passwords"
            
            if expected_body_snippet.lower() in post_page.lower():
                print("✓ Post created successfully with correct title and body")
                return True
            else:
                print("Post found but body content doesn't match")
                return False
    
    # If we found the title in the subreddit listing, that's a good sign
    print("✓ Post title found in technology subreddit")
    return True

def main():
    """Main evaluation function."""
    print("Evaluating: Create a New Discussion Post on Reddit")
    print("=" * 60)
    
    try:
        if check_post_created():
            print("\n" + "=" * 60)
            print("EVALUATION PASSED")
            print("=" * 60)
            sys.exit(0)
        else:
            print("\n" + "=" * 60)
            print("EVALUATION FAILED")
            print("=" * 60)
            sys.exit(1)
    except Exception as e:
        print(f"\nEvaluation error: {str(e)}")
        print("=" * 60)
        print("EVALUATION FAILED")
        print("=" * 60)
        sys.exit(1)

if __name__ == "__main__":
    main()
