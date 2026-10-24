# Apple trust anchors

Public DER certificates downloaded from Apple's PKI on October 23, 2026:

- https://www.apple.com/appleca/AppleIncRootCertificate.cer
- https://www.apple.com/certificateauthority/AppleRootCA-G2.cer
- https://www.apple.com/certificateauthority/AppleRootCA-G3.cer

These are public trust anchors, not private signing keys. The Docker image sets
`APPLE_ROOT_CERTIFICATES_DIR` to this directory. Tests pin their SHA-256 fingerprints,
check validity and CA constraints. Review
Apple's PKI page and update the pins when rotating these certificates.
