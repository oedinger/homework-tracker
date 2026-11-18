#!/usr/bin/env python3
"""Import tasks.json into homework.db (replace set, preserving done-state).
Usage: python3 import_tasks.py [path/to/tasks.json] (default: tasks.json next to this script)"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from server import import_tasks

if __name__ == "__main__":
    default = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks.json")
    import_tasks(sys.argv[1] if len(sys.argv) > 1 else default)
    print("import ok")
