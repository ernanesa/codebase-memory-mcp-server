from urllib.parse import urlsplit


GOOGLE_DRIVE_CITATION_HOSTS = {'docs.google.com', 'drive.google.com'}


def get_file_citation_metadata(file):
    """Return a safe display name and canonical source for an uploaded file."""
    filename = getattr(file, 'filename', '') or 'N/A'
    metadata = getattr(file, 'meta', None)
    if not isinstance(metadata, dict):
        return {'name': filename, 'source': filename}

    data = metadata.get('data')
    if not isinstance(data, dict) or data.get('source') not in {'google-drive', 'web-link'}:
        return {'name': filename, 'source': filename}

    original_name = data.get('original_name') or data.get('source_name')
    display_name = original_name.strip() if isinstance(original_name, str) and original_name.strip() else filename

    source_url = data.get('source_url')
    if isinstance(source_url, str):
        try:
            parsed = urlsplit(source_url.strip())
            valid_google_source = data.get('source') == 'google-drive' and parsed.hostname in GOOGLE_DRIVE_CITATION_HOSTS
            valid_web_source = data.get('source') == 'web-link' and bool(parsed.hostname) and not parsed.username and not parsed.password
            if parsed.scheme == 'https' and (valid_google_source or valid_web_source):
                return {'name': display_name, 'source': source_url.strip()}
        except ValueError:
            pass

    return {'name': display_name, 'source': filename}
