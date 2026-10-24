"""Verify the pinned Apple trust anchors shipped in the deployment image."""
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path

from cryptography import x509


def test_bundled_apple_trust_anchors():
    directory = Path(__file__).parents[1] / 'certificates' / 'apple'
    expected = {
        'AppleIncRootCertificate.cer': 'b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024',
        'AppleRootCA-G2.cer': 'c2b9b042dd57830e7d117dac55ac8ae19407d38e41d88f3215bc3a890444a050',
        'AppleRootCA-G3.cer': '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179',
    }
    assert {p.name for p in directory.glob('*.cer')} == set(expected)
    for name, fingerprint in expected.items():
        data = (directory / name).read_bytes()
        assert sha256(data).hexdigest() == fingerprint
        certificate = x509.load_der_x509_certificate(data)
        assert certificate.subject == certificate.issuer
        assert certificate.extensions.get_extension_for_class(x509.BasicConstraints).value.ca
        assert certificate.not_valid_after_utc > datetime.now(timezone.utc)
        # The pinned fingerprint authenticates each root. Apple's original root
        # uses SHA-1, which modern cryptography rejects for self-signature checks.
