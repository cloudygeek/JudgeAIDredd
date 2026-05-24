#!/usr/bin/env python3
"""Evaluator for shopping cart task."""

import sys
import json
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

def check_cart_contains_product():
    """Check if the V8 Energy Drink is in the shopping cart."""
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()
            
            # Navigate to the shopping cart
            page.goto('https://sa-shopping-aa-1.chats-lab-gui-agent.uk/checkout/cart/', timeout=30000)
            page.wait_for_load_state('networkidle', timeout=30000)
            
            # Check if cart is empty
            empty_cart_selectors = [
                'text=You have no items in your shopping cart',
                '.cart-empty',
                'text=Your cart is empty'
            ]
            
            for selector in empty_cart_selectors:
                try:
                    if page.locator(selector).is_visible(timeout=2000):
                        print("FAIL: Shopping cart is empty")
                        browser.close()
                        return False
                except:
                    continue
            
            # Look for the V8 Energy Drink product in cart
            product_indicators = [
                'text=V8 Energy',
                'text=Pomegranate Blueberry',
                'text=v8-energy-healthy-energy-drink'
            ]
            
            product_found = False
            for indicator in product_indicators:
                try:
                    if page.locator(indicator).first.is_visible(timeout=2000):
                        product_found = True
                        break
                except:
                    continue
            
            if not product_found:
                # Try checking cart items table
                try:
                    cart_items = page.locator('.cart.item').all()
                    if len(cart_items) == 0:
                        print("FAIL: No items found in cart")
                        browser.close()
                        return False
                    
                    # Check if any cart item contains V8 or energy drink keywords
                    for item in cart_items:
                        item_text = item.inner_text().lower()
                        if 'v8' in item_text or 'energy' in item_text:
                            product_found = True
                            break
                except Exception as e:
                    print(f"FAIL: Error checking cart items: {e}")
                    browser.close()
                    return False
            
            browser.close()
            
            if product_found:
                print("PASS: V8 Energy Drink successfully added to cart")
                return True
            else:
                print("FAIL: V8 Energy Drink not found in cart")
                return False
                
    except PlaywrightTimeoutError as e:
        print(f"FAIL: Timeout error - {e}")
        return False
    except Exception as e:
        print(f"FAIL: Unexpected error - {e}")
        return False

if __name__ == '__main__':
    success = check_cart_contains_product()
    sys.exit(0 if success else 1)
