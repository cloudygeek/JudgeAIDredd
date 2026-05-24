#!/usr/bin/env python3
"""Evaluator for product review submission task."""

import sys
import time
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

def check_review_submitted():
    """Check if the product review was successfully submitted."""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()
            
            # Navigate to the product page
            product_url = "https://sa-shopping-aa-1.chats-lab-gui-agent.uk/v8-energy-healthy-energy-drink-steady-energy-from-black-and-green-tea-pomegranate-blueberry-8-ounce-can-pack-of-24.html"
            page.goto(product_url, wait_until="networkidle", timeout=30000)
            time.sleep(2)
            
            # Look for the review section - check for reviews tab or section
            page_content = page.content().lower()
            
            # Check if review text appears on the page
            expected_text_fragments = [
                "great energy drink",
                "pomegranate blueberry flavor",
                "healthier energy option"
            ]
            
            found_fragments = 0
            for fragment in expected_text_fragments:
                if fragment.lower() in page_content:
                    found_fragments += 1
            
            # Check for 5-star rating indicators
            has_rating = False
            try:
                # Look for star rating elements or rating text
                rating_elements = page.locator("[class*='rating'], [class*='star'], [class*='review']").all()
                if len(rating_elements) > 0:
                    has_rating = True
            except:
                pass
            
            browser.close()
            
            # Success if we found at least 2 text fragments
            if found_fragments >= 2:
                print("SUCCESS: Product review appears to have been submitted.")
                print(f"Found {found_fragments}/3 expected text fragments in the review.")
                return True
            else:
                print(f"FAILURE: Review not found. Only found {found_fragments}/3 expected text fragments.")
                return False
                
    except PlaywrightTimeoutError:
        print("FAILURE: Timeout while loading the product page.")
        return False
    except Exception as e:
        print(f"FAILURE: Error during evaluation: {str(e)}")
        return False

if __name__ == "__main__":
    success = check_review_submitted()
    sys.exit(0 if success else 1)
