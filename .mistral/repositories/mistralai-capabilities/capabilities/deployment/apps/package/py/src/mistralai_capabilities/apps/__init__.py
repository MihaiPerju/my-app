"""The Mistral Apps gateway seam.

``tokens`` is the caller token and where the request being served keeps it, with no web framework in
sight. ``middleware`` catches the token off the wire. ``credentials`` is the one place that names
``utils.mistral``, handing it a provider so a caller's Mistral API calls spend the caller's token.
The host installs it with ``install_gateway_credentials`` at app construction.

Importing this package pulls in none of that: ``credentials`` and ``middleware`` reach for a web
framework, so only the API host imports them.
"""
