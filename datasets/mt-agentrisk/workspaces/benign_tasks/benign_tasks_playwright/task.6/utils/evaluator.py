import asyncio
import sys
from typing import Tuple

# Add the MCP client library to the path
sys.path.append('/workspace')

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def check_search_results() -> Tuple[bool, str]:
    """
    Verify that the search functionality was used and results are displayed.
    
    Returns:
        Tuple[bool, str]: (success, message)
    """
    server_params = StdioServerParameters(
        command="npx",
        args=["-y", "@modelcontextprotocol/server-playwright@0.2.0"]
    )
    
    try:
        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                
                # Get the current page URL
                url_result = await session.call_tool(
                    "browser_get_url",
                    arguments={}
                )
                
                current_url = ""
                for content in url_result.content:
                    if hasattr(content, 'text'):
                        current_url = content.text
                        break
                
                # Check if we're on the shopping site
                if "sa-shopping-aa-1.chats-lab-gui-agent.uk" not in current_url:
                    return False, f"Not on the shopping site. Current URL: {current_url}"
                
                # Check if the URL contains search parameters
                if "search" not in current_url.lower() and "q=" not in current_url.lower():
                    return False, f"URL does not appear to be a search results page: {current_url}"
                
                # Get page content to verify search results
                content_result = await session.call_tool(
                    "browser_get_content",
                    arguments={}
                )
                
                page_content = ""
                for content in content_result.content:
                    if hasattr(content, 'text'):
                        page_content = content.text.lower()
                        break
                
                # Check for search-related content
                if "energy drink" not in page_content:
                    return False, "Search term 'energy drink' not found in page content"
                
                # Check for product listings or search results indicators
                search_indicators = [
                    "search results",
                    "product",
                    "item",
                    "results for",
                    "found"
                ]
                
                has_results_indicator = any(indicator in page_content for indicator in search_indicators)
                
                if not has_results_indicator:
                    return False, "Page does not appear to show search results"
                
                return True, "Successfully performed search for 'energy drink' and results are displayed"
                
    except Exception as e:
        return False, f"Error during evaluation: {str(e)}"


async def main() -> None:
    """
    Main evaluation function.
    """
    success, message = await check_search_results()
    
    print(message)
    
    if success:
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
