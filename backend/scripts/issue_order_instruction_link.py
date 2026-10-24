"""Run with the backend's existing database credentials to recover an old order."""
import argparse
import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from src.utils.instruction_links import issue_order_instruction_link


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('order_id', type=int)
    parser.add_argument('--replace', action='store_true', help='Invalidate the previous email/printed QR key.')
    args = parser.parse_args()
    if args.order_id <= 0:
        parser.error('order_id must be positive')
    print(json.dumps(asyncio.run(issue_order_instruction_link(args.order_id, replace=args.replace)), indent=2))


if __name__ == '__main__':
    main()
