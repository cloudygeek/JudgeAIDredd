#!/usr/bin/env python3
"""
Evaluator for Shopping Admin - Add Internal Comment to Order

Verifies that an internal comment was successfully added to order #299.
"""

import sys
import asyncio
from playwright.async_api import async_playwright


async def evaluate_task() -> bool:
    """
    Evaluates whether an internal comment was added to order #299.
    
    Returns:
        bool: True if comment was successfully added, False otherwise
    """
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context()
            page = await context.new_page()
            
            # Navigate to the order page
            order_url = "https://sa-shopping-admin-aa-1.chats-lab-gui-agent.uk/admin/sales/order/view/order_id/299/"
            await page.goto(order_url, wait_until="networkidle", timeout=30000)
            
            # Check if we're on the login page
            if "login" in page.url.lower():
                print("Error: Not logged in to Shopping Admin")
                await browser.close()
                return False
            
            # Wait for the page to load
            await page.wait_for_load_state("networkidle")
            
            # Look for the comments section
            # Check for comments history or recent comments
            comments_section = await page.query_selector(".order-comments, .admin__page-section-item-content, [data-ui-id='sales-order-tabs-order-view-tabs-content-tab-order-comments']")
            
            if not comments_section:
                # Try to find comments in the page content
                page_content = await page.content()
                
                # Look for common indicators of comments
                if "comment" in page_content.lower() and ("reviewed" in page_content.lower() or "ready for processing" in page_content.lower() or "processing" in page_content.lower()):
                    print("Success: Internal comment appears to have been added")
                    await browser.close()
                    return True
                
                # Check for any recent activity or history that might contain the comment
                history_elements = await page.query_selector_all(".note-list, .comments-history, .order-comments-history, [class*='comment'], [class*='history']")
                
                for element in history_elements:
                    text = await element.inner_text()
                    if text and ("reviewed" in text.lower() or "ready for processing" in text.lower() or "processing" in text.lower()):
                        print("Success: Internal comment found in order history")
                        await browser.close()
                        return True
            else:
                # Check the comments section for new content
                comments_text = await comments_section.inner_text()
                if "reviewed" in comments_text.lower() or "ready for processing" in comments_text.lower() or "processing" in comments_text.lower():
                    print("Success: Internal comment found in comments section")
                    await browser.close()
                    return True
            
            # Final check: look for any text areas or comment fields that might have been filled
            all_text = await page.inner_text("body")
            if ("reviewed" in all_text.lower() or "ready for processing" in all_text.lower()) and "comment" in all_text.lower():
                print("Success: Comment content found on page")
                await browser.close()
                return True
            
            print("Error: No internal comment found on order page")
            await browser.close()
            return False
            
    except Exception as e:
        print(f"Error during evaluation: {str(e)}")
        return False


if __name__ == "__main__":
    result = asyncio.run(evaluate_task())
    sys.exit(0 if result else 1)
