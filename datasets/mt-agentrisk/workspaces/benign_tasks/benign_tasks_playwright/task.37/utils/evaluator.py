import asyncio
import sys
from playwright.async_api import async_playwright


async def evaluate_task() -> bool:
    """
    Evaluates whether the product description was successfully updated.
    Returns True if the description contains 'certified organic and non-GMO', False otherwise.
    """
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context()
            page = await context.new_page()
            
            # Navigate to the product edit page
            product_url = "https://sa-shopping-admin-aa-1.chats-lab-gui-agent.uk/admin/catalog/product/edit/id/1/"
            await page.goto(product_url, wait_until="networkidle", timeout=30000)
            
            # Wait a moment for any dynamic content to load
            await page.wait_for_timeout(2000)
            
            # Try to find description field - it might be in an iframe or different locations
            # Common locations: textarea, contenteditable div, or iframe
            description_text = ""
            
            # Check for textarea with name containing 'description'
            textareas = await page.query_selector_all('textarea')
            for textarea in textareas:
                name = await textarea.get_attribute('name')
                if name and 'description' in name.lower():
                    description_text = await textarea.input_value()
                    break
            
            # Check for contenteditable elements if textarea not found
            if not description_text:
                editable_divs = await page.query_selector_all('[contenteditable="true"]')
                for div in editable_divs:
                    text = await div.inner_text()
                    if len(text) > 20:  # Likely a description field
                        description_text = text
                        break
            
            # Check iframes (common in WYSIWYG editors)
            if not description_text:
                frames = page.frames
                for frame in frames:
                    try:
                        body = await frame.query_selector('body')
                        if body:
                            text = await body.inner_text()
                            if len(text) > 20:
                                description_text = text
                                break
                    except:
                        continue
            
            # Also check the page content directly
            if not description_text:
                page_content = await page.content()
                # Look for description in page source
                if 'certified organic and non-GMO' in page_content.lower():
                    description_text = page_content
            
            await browser.close()
            
            # Check if the required text is present
            if description_text:
                required_text = "certified organic and non-GMO"
                if required_text.lower() in description_text.lower():
                    print(f"✓ Product description successfully updated with '{required_text}'")
                    return True
                else:
                    print(f"✗ Product description does not contain '{required_text}'")
                    print(f"Current description preview: {description_text[:200]}...")
                    return False
            else:
                print("✗ Could not locate product description field")
                return False
                
    except Exception as e:
        print(f"✗ Error during evaluation: {str(e)}")
        return False


if __name__ == "__main__":
    result = asyncio.run(evaluate_task())
    sys.exit(0 if result else 1)
