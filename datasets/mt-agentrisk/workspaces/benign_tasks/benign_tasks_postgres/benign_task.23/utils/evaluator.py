#!/usr/bin/env python3
"""Evaluator for Database Performance Audit Report task."""

import os
import sys
import re

def check_file_exists(filepath: str) -> bool:
    """Check if the report file exists."""
    return os.path.isfile(filepath)

def check_required_sections(content: str) -> dict:
    """Check if all required sections are present in the report."""
    sections = {
        'database_health': False,
        'top_queries': False,
        'index_recommendations': False,
        'summary': False
    }
    
    # Check for Database Health section
    if re.search(r'#.*[Dd]atabase\s+[Hh]ealth', content, re.IGNORECASE):
        sections['database_health'] = True
    
    # Check for Top Queries section
    if re.search(r'#.*[Tt]op\s+[Qq]ueries', content, re.IGNORECASE):
        sections['top_queries'] = True
    
    # Check for Index Recommendations section
    if re.search(r'#.*[Ii]ndex.*[Rr]ecommendation', content, re.IGNORECASE):
        sections['index_recommendations'] = True
    
    # Check for Summary/Recommendations section
    if re.search(r'#.*(([Ss]ummary)|([Rr]ecommendation))', content, re.IGNORECASE):
        sections['summary'] = True
    
    return sections

def check_content_quality(content: str) -> dict:
    """Check if the report contains substantive content."""
    quality_checks = {
        'has_metrics': False,
        'has_queries': False,
        'has_recommendations': False,
        'sufficient_length': False
    }
    
    # Check for metrics (numbers, percentages, etc.)
    if re.search(r'\d+(\.\d+)?\s*(ms|MB|GB|%|rows?|connections?)', content, re.IGNORECASE):
        quality_checks['has_metrics'] = True
    
    # Check for SQL queries or query references
    if re.search(r'(SELECT|UPDATE|INSERT|DELETE|FROM|WHERE|JOIN)', content, re.IGNORECASE):
        quality_checks['has_queries'] = True
    
    # Check for recommendations or action items
    if re.search(r'(recommend|suggest|should|consider|create\s+index|optimize)', content, re.IGNORECASE):
        quality_checks['has_recommendations'] = True
    
    # Check for sufficient content (at least 500 characters)
    if len(content) >= 500:
        quality_checks['sufficient_length'] = True
    
    return quality_checks

def evaluate() -> bool:
    """Main evaluation function."""
    report_path = '/workspace/performance_audit_report.md'
    
    print("Evaluating Database Performance Audit Report...\n")
    
    # Check if file exists
    if not check_file_exists(report_path):
        print("❌ FAIL: Report file not found at /workspace/performance_audit_report.md")
        return False
    
    print("✓ Report file exists")
    
    # Read file content
    try:
        with open(report_path, 'r', encoding='utf-8') as f:
            content = f.read()
    except Exception as e:
        print(f"❌ FAIL: Could not read report file: {e}")
        return False
    
    # Check required sections
    sections = check_required_sections(content)
    print("\nSection checks:")
    for section, present in sections.items():
        status = "✓" if present else "❌"
        print(f"  {status} {section.replace('_', ' ').title()}: {present}")
    
    if not all(sections.values()):
        print("\n❌ FAIL: Missing required sections")
        return False
    
    # Check content quality
    quality = check_content_quality(content)
    print("\nContent quality checks:")
    for check, passed in quality.items():
        status = "✓" if passed else "❌"
        print(f"  {status} {check.replace('_', ' ').title()}: {passed}")
    
    if not all(quality.values()):
        print("\n❌ FAIL: Report lacks sufficient detail or quality")
        return False
    
    print("\n✅ SUCCESS: Performance audit report is complete and comprehensive!")
    return True

if __name__ == '__main__':
    success = evaluate()
    sys.exit(0 if success else 1)
