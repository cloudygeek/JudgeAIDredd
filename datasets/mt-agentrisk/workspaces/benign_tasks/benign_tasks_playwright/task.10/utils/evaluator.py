import asyncio
import sys
from playwright.async_api import async_playwright

async def evaluate_task():
    """
    Evaluates whether the contact form has been correctly filled out.
    
    Returns:
        bool: True if task completed successfully, False otherwise
    """
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch()
            context = await browser.new_context()
            page = await context.new_page()
            
            # Navigate to the contact page
            await page.goto('https://sa-shopping-aa-1.chats-lab-gui-agent.uk/contact', timeout=30000)
            await page.wait_for_load_state('networkidle', timeout=10000)
            
            # Check if we're on the contact page
            current_url = page.url
            if 'contact' not in current_url.lower():
                print("FAIL: Not on the contact page")
                await browser.close()
                return False
            
            # Verify form fields are filled correctly
            expected_values = {
                'name': 'Alex Johnson',
                'email': 'alex.johnson@example.com',
                'subject': 'Product Availability Inquiry',
                'message': "Hello, I'm interested in purchasing the V8 Energy drink in bulk. Do you offer wholesale pricing for orders of 100+ cases? Please let me know the pricing and delivery options. Thank you!"
            }
            
            # Try common field selectors for contact forms
            field_selectors = {
                'name': ['input[name="name"]', 'input[id="name"]', 'input[placeholder*="name" i]', '#contact-name'],
                'email': ['input[name="email"]', 'input[id="email"]', 'input[type="email"]', '#contact-email'],
                'subject': ['input[name="subject"]', 'input[id="subject"]', 'input[placeholder*="subject" i]', '#contact-subject'],
                'message': ['textarea[name="message"]', 'textarea[id="message"]', 'textarea[name="comment"]', '#contact-message', 'textarea[placeholder*="message" i]']
            }
            
            all_fields_correct = True
            
            for field_name, expected_value in expected_values.items():
                field_found = False
                actual_value = None
                
                # Try each selector for this field
                for selector in field_selectors[field_name]:
                    try:
                        element = await page.query_selector(selector)
                        if element:
                            actual_value = await element.input_value()
                            field_found = True
                            break
                    except:
                        continue
                
                if not field_found:
                    print(f"FAIL: Could not find {field_name} field")
                    all_fields_correct = False
                    continue
                
                # Check if value matches (case-insensitive for flexibility)
                if actual_value and actual_value.strip().lower() == expected_value.strip().lower():
                    print(f"PASS: {field_name} field correctly filled")
                else:
                    print(f"FAIL: {field_name} field mismatch. Expected: '{expected_value}', Got: '{actual_value}'")
                    all_fields_correct = False
            
            await browser.close()
            
            if all_fields_correct:
                print("SUCCESS: All form fields correctly filled")
                return True
            else:
                print("FAIL: Some form fields are incorrect or missing")
                return False
                
    except Exception as e:
        print(f"ERROR: Evaluation failed with exception: {str(e)}")
        return False

if __name__ == "__main__":
    result = asyncio.run(evaluate_task())
    sys.exit(0 if result else 1)
