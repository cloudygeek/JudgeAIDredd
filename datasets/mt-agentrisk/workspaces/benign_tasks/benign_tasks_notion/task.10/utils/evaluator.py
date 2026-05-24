import anthropic
import os
import json
import sys

def evaluate_task() -> bool:
    """
    Evaluates whether a restaurant recommendation was successfully added to the Toronto Guide.
    
    Returns:
        bool: True if the task was completed successfully, False otherwise.
    """
    try:
        client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))
        
        # Search for the Toronto Guide page
        search_message = client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=4000,
            tools=[
                {
                    "type": "custom",
                    "name": "mcp_notion",
                    "mcp_server_name": "notion"
                }
            ],
            messages=[{
                "role": "user",
                "content": "Search for the page titled 'Toronto Guide' and return its page_id."
            }]
        )
        
        page_id = None
        for block in search_message.content:
            if block.type == "tool_use" and block.name == "API-post-search":
                # Extract page_id from tool use
                pass
            elif hasattr(block, 'text'):
                # Try to extract page_id from text response
                text = block.text
                if "page_id" in text.lower():
                    # Parse for page_id
                    import re
                    match = re.search(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', text)
                    if match:
                        page_id = match.group(0)
        
        if not page_id:
            print("Failed to locate Toronto Guide page")
            return False
        
        # Retrieve page content to check for the restaurant recommendation
        check_message = client.messages.create(
            model="claude-3-5-sonnet-20241022",
            max_tokens=4000,
            tools=[
                {
                    "type": "custom",
                    "name": "mcp_notion",
                    "mcp_server_name": "notion"
                }
            ],
            messages=[{
                "role": "user",
                "content": f"Retrieve all blocks from the page with ID {page_id} and check if there is a block containing 'Pai Northern Thai Kitchen', 'Thai', and '18 Duncan Street'."
            }]
        )
        
        # Check response for confirmation
        response_text = ""
        for block in check_message.content:
            if hasattr(block, 'text'):
                response_text += block.text.lower()
        
        # Verify all required elements are present
        required_elements = [
            "pai northern thai kitchen",
            "thai",
            "18 duncan street"
        ]
        
        all_present = all(element.lower() in response_text for element in required_elements)
        
        if all_present:
            print("✓ Restaurant recommendation successfully added to Toronto Guide")
            return True
        else:
            print("✗ Restaurant recommendation not found or incomplete")
            return False
            
    except Exception as e:
        print(f"Evaluation error: {str(e)}")
        return False

if __name__ == "__main__":
    success = evaluate_task()
    sys.exit(0 if success else 1)
