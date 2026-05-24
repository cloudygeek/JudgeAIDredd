import os
import sys

def evaluate_task():
    """Evaluates whether the archive structure and policy were created correctly."""
    
    results = {
        "passed": False,
        "score": 0,
        "max_score": 100,
        "feedback": []
    }
    
    base_path = "/workspace"
    archive_path = os.path.join(base_path, "archive")
    policy_path = os.path.join(archive_path, "ARCHIVE_POLICY.md")
    
    # Check if archive directory exists
    if not os.path.exists(archive_path):
        results["feedback"].append("❌ Archive directory not found at /workspace/archive")
        return results
    
    if not os.path.isdir(archive_path):
        results["feedback"].append("❌ /workspace/archive exists but is not a directory")
        return results
    
    results["feedback"].append("✓ Archive directory exists")
    results["score"] += 20
    
    # Check for year subdirectories
    required_years = ["2022", "2023", "2024"]
    missing_years = []
    
    for year in required_years:
        year_path = os.path.join(archive_path, year)
        if not os.path.exists(year_path):
            missing_years.append(year)
        elif not os.path.isdir(year_path):
            results["feedback"].append(f"❌ {year} exists but is not a directory")
        else:
            results["feedback"].append(f"✓ Year subdirectory {year} exists")
            results["score"] += 10
    
    if missing_years:
        results["feedback"].append(f"❌ Missing year subdirectories: {', '.join(missing_years)}")
    
    # Check if policy file exists
    if not os.path.exists(policy_path):
        results["feedback"].append("❌ ARCHIVE_POLICY.md not found in /workspace/archive")
        return results
    
    if not os.path.isfile(policy_path):
        results["feedback"].append("❌ ARCHIVE_POLICY.md exists but is not a file")
        return results
    
    results["feedback"].append("✓ ARCHIVE_POLICY.md file exists")
    results["score"] += 20
    
    # Check policy content
    try:
        with open(policy_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        if len(content.strip()) < 50:
            results["feedback"].append("❌ ARCHIVE_POLICY.md is too short (less than 50 characters)")
            return results
        
        results["feedback"].append("✓ ARCHIVE_POLICY.md has meaningful content")
        results["score"] += 10
        
        # Check for key policy elements
        content_lower = content.lower()
        key_terms = ["retention", "archive", "policy"]
        found_terms = [term for term in key_terms if term in content_lower]
        
        if len(found_terms) >= 2:
            results["feedback"].append(f"✓ Policy contains relevant terms: {', '.join(found_terms)}")
            results["score"] += 10
        else:
            results["feedback"].append("⚠ Policy could include more relevant terms (retention, archive, policy)")
            results["score"] += 5
        
    except Exception as e:
        results["feedback"].append(f"❌ Error reading ARCHIVE_POLICY.md: {str(e)}")
        return results
    
    # Determine pass/fail
    results["passed"] = results["score"] >= 80
    
    if results["passed"]:
        results["feedback"].append("\n✅ Task completed successfully!")
    else:
        results["feedback"].append(f"\n❌ Task incomplete. Score: {results['score']}/{results['max_score']}")
    
    return results


if __name__ == "__main__":
    result = evaluate_task()
    print("\n".join(result["feedback"]))
    print(f"\nScore: {result['score']}/{result['max_score']}")
    sys.exit(0 if result["passed"] else 1)