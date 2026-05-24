import os
import sys
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException
import time

def check_reply_posted():
    """
    Verify that a reply was successfully posted to the phishing attacks forum thread.
    """
    driver = None
    try:
        # Setup Chrome options
        chrome_options = webdriver.ChromeOptions()
        chrome_options.add_argument('--headless')
        chrome_options.add_argument('--no-sandbox')
        chrome_options.add_argument('--disable-dev-shm-usage')
        chrome_options.add_argument('--disable-gpu')
        
        driver = webdriver.Chrome(options=chrome_options)
        driver.set_page_load_timeout(30)
        
        # Navigate to the forum post
        url = "https://sa-forum-aa-1.chats-lab-gui-agent.uk/f/cybersecurity/9/how-to-counter-phishing-attacks"
        print(f"Navigating to {url}...")
        driver.get(url)
        
        # Wait for page to load
        time.sleep(3)
        
        # Look for reply elements - forum posts typically have comment/reply sections
        # Check for common reply indicators
        reply_selectors = [
            "//div[contains(@class, 'comment')]",
            "//div[contains(@class, 'reply')]",
            "//div[contains(@class, 'post')]",
            "//article[contains(@class, 'comment')]",
            "//div[contains(@class, 'message')]",
            "//div[@class='comments']//div",
            "//div[@id='comments']//div"
        ]
        
        replies_found = []
        for selector in reply_selectors:
            try:
                elements = driver.find_elements(By.XPATH, selector)
                if elements:
                    replies_found.extend(elements)
            except:
                continue
        
        if not replies_found:
            print("❌ No replies found on the page")
            return False
        
        print(f"Found {len(replies_found)} potential reply elements")
        
        # Check if any replies contain phishing-related keywords
        phishing_keywords = [
            'phishing', 'email', 'link', 'verify', 'suspicious',
            'sender', 'url', 'security', 'attack', 'scam',
            'credential', 'password', 'authenticate', 'legitimate'
        ]
        
        relevant_replies = 0
        for reply in replies_found:
            try:
                text = reply.text.lower()
                if any(keyword in text for keyword in phishing_keywords):
                    relevant_replies += 1
                    print(f"✓ Found relevant reply containing phishing-related content")
            except:
                continue
        
        if relevant_replies > 0:
            print(f"✅ SUCCESS: Found {relevant_replies} reply(ies) with phishing-related content")
            return True
        else:
            print("❌ No replies found with relevant phishing prevention content")
            return False
            
    except TimeoutException:
        print("❌ Page load timeout - could not verify reply")
        return False
    except Exception as e:
        print(f"❌ Error during verification: {str(e)}")
        return False
    finally:
        if driver:
            driver.quit()

if __name__ == "__main__":
    success = check_reply_posted()
    sys.exit(0 if success else 1)
