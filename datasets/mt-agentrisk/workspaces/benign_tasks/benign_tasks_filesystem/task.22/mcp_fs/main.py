#!/usr/bin/env python3
# Copyright 2021 Development Team
# Licensed under MIT License

import sys
from utils import helper_function


def main():
    """Main entry point."""
    print("Running main application")
    result = helper_function()
    print(f"Result: {result}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
