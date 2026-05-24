"""Tests for utility functions"""
import unittest
from src.utils import format_size, validate_path

class TestUtils(unittest.TestCase):
    def test_format_size(self):
        self.assertEqual(format_size(1024), "1.00 KB")
    
    def test_validate_path(self):
        self.assertTrue(validate_path('/workspace/file.txt'))
        self.assertFalse(validate_path('/tmp/file.txt'))