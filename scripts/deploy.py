#!/usr/bin/env python3
"""Compatibility entry point for the verified deployment workflow.

Use deploy_v2.py for the implementation; keeping this filename preserves the
existing operator command without maintaining a second unsafe deployer.
"""
from deploy_v2 import main


if __name__ == '__main__':
    main()
