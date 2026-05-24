import asyncio
import sys
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError

async def evaluate_task() -> bool:
    """
    Evaluates whether a discussion post was successfully created on Reddit.
    
    Returns:
        bool: True if the post exists with correct title and body, False otherwise
    """
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context()
            page = await context.new_page()
            
            # Navigate to the Technology subreddit
            await page.goto('https://sa-forum-aa-1.chats-lab-gui-agent.uk/f/technology', timeout=30000)
            await page.wait_for_load_state('networkidle', timeout=10000)
            
            # Expected post details
            expected_title = "The Future of AI in Healthcare"
            expected_body_snippet = "artificial intelligence will transform healthcare"
            
            # Look for the post title on the page
            try:
                # Try to find the post by title
                post_link = page.locator(f'a:has-text("{expected_title}")')
                await post_link.wait_for(state='visible', timeout=10000)
                
                # Click on the post to view full content
                await post_link.click()
                await page.wait_for_load_state('networkidle', timeout=10000)
                
                # Verify the body content contains the expected text
                page_content = await page.content()
                
                if expected_body_snippet.lower() in page_content.lower():
                    print("✓ Post found with correct title and body content")
                    await browser.close()
                    return True
                else:
                    print("✗ Post found but body content doesn't match")
                    await browser.close()
                    return False
                    
            except PlaywrightTimeoutError:
                print(f"✗ Post with title '{expected_title}' not found in Technology subreddit")
                await browser.close()
                return False
                
    except Exception as e:
        print(f"✗ Evaluation failed with error: {str(e)}")
        return False

if __name__ == "__main__":
    result = asyncio.run(evaluate_task())
    sys.exit(0 if result else 1)
