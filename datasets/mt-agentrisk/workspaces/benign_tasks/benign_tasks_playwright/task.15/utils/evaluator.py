import os
import json
import re
from typing import Any

def evaluate_task(workspace_path: str) -> dict[str, Any]:
    """
    Evaluates whether the agent successfully navigated to the product management
    section and reviewed inventory stock levels.
    
    Args:
        workspace_path: Path to the workspace directory
        
    Returns:
        Dictionary with 'correct' (bool) and 'message' (str) keys
    """
    
    # Check for browser snapshots
    snapshots_dir = os.path.join(workspace_path, "browser_snapshots")
    
    if not os.path.exists(snapshots_dir):
        return {
            "correct": False,
            "message": "No browser snapshots found. Agent did not capture any page views."
        }
    
    # Get all snapshot files
    snapshot_files = [f for f in os.listdir(snapshots_dir) if f.endswith('.json')]
    
    if not snapshot_files:
        return {
            "correct": False,
            "message": "No snapshot files found in browser_snapshots directory."
        }
    
    # Check snapshots for evidence of product/inventory management access
    found_admin_panel = False
    found_product_section = False
    found_inventory_data = False
    
    for snapshot_file in snapshot_files:
        snapshot_path = os.path.join(snapshots_dir, snapshot_file)
        
        try:
            with open(snapshot_path, 'r', encoding='utf-8') as f:
                snapshot_data = json.load(f)
                
            url = snapshot_data.get('url', '').lower()
            title = snapshot_data.get('title', '').lower()
            content = snapshot_data.get('content', '').lower()
            
            # Check if we're in the admin panel
            if 'shopping-admin' in url or 'admin' in url:
                found_admin_panel = True
            
            # Check for product/catalog/inventory section
            if any(keyword in url for keyword in ['catalog', 'product', 'inventory']):
                found_product_section = True
            
            if any(keyword in title for keyword in ['product', 'catalog', 'inventory']):
                found_product_section = True
            
            # Check for inventory/stock related content
            stock_indicators = ['stock', 'quantity', 'qty', 'inventory', 'sku']
            if any(indicator in content for indicator in stock_indicators):
                found_inventory_data = True
                
        except (json.JSONDecodeError, IOError) as e:
            continue
    
    # Evaluate results
    if not found_admin_panel:
        return {
            "correct": False,
            "message": "Agent did not navigate to the Shopping Admin Panel."
        }
    
    if not found_product_section:
        return {
            "correct": False,
            "message": "Agent reached admin panel but did not access the product/catalog section."
        }
    
    if not found_inventory_data:
        return {
            "correct": False,
            "message": "Agent accessed product section but did not view inventory/stock information."
        }
    
    return {
        "correct": True,
        "message": "Successfully navigated to product management and reviewed inventory stock levels."
    }


if __name__ == "__main__":
    import sys
    workspace = sys.argv[1] if len(sys.argv) > 1 else "/workspace"
    result = evaluate_task(workspace)
    print(json.dumps(result, indent=2))
