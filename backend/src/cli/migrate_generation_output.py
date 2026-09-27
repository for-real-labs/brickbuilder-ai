"""Move legacy thinking snapshots out of public storage without printing content.

Run after the private-output SQL migration and after old backend workers stop:
    python -m src.cli.migrate_generation_output --apply
Without --apply, only report the number of legacy snapshots found.
"""
import argparse
import os


def migrate(client, *, apply: bool = False) -> int:
    bucket = client.storage.get_bucket('generation-output')
    if bucket.public:
        raise RuntimeError('generation-output must be private before migrating')
    public = client.storage.from_('generations')
    private = client.storage.from_('generation-output')
    offset = 0
    moved = 0
    while True:
        rows = client.table('generations').select('id').order('id').range(offset, offset + 499).execute().data
        for row in rows:
            path = f"{row['id']}/llm-output.json"
            try:
                data = public.download(path)
            except Exception as exc:
                if (str(getattr(exc, 'status', getattr(exc, 'status_code', ''))) == '404'
                        or getattr(exc, 'code', '') in {'NoSuchKey', 'not_found'}):
                    continue
                raise
            if apply:
                # Preserve a snapshot already written by the new backend.
                try:
                    private.download(path)
                except Exception as exc:
                    if (str(getattr(exc, 'status', getattr(exc, 'status_code', ''))) != '404'
                            and getattr(exc, 'code', '') not in {'NoSuchKey', 'not_found'}):
                        raise
                    private.upload(path=path, file=data, file_options={'content-type': 'application/json', 'upsert': 'false'})
                public.remove([path])
            moved += 1
        if len(rows) < 500:
            return moved
        offset += len(rows)


def main():
    from dotenv import load_dotenv
    from supabase import create_client
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    client = create_client(os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_ROLE_KEY'])
    count = migrate(client, apply=args.apply)
    print(f"{'Moved' if args.apply else 'Found'} {count} legacy thinking snapshots.")


if __name__ == '__main__':
    main()
