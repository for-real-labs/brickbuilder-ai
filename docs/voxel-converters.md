# Mesh-to-voxel converters

Public routes: `/{glb,obj}-to-{vox,qb,binvox,xyzrgb}`. Every route has a
pre-rendered document, canonical URL, Open Graph/Twitter metadata, visible FAQ
and matching FAQ schema, WebApplication schema, breadcrumbs, sitemap entry,
HTML-to-canonical redirect, and links from the site footer and related tools.
The shared footer promotes LEGO design on other converter pages; voxel pages
place the same promotion directly beneath the uploader.

`POST /meshToVoxels` accepts multipart `file`, `input_format` (`glb` or `obj`),
`output_format`, and integer `resolution` (8–64). It uses the existing optional
user/guest authentication and rate limits. The response is a private,
non-cacheable file attachment; uploads and artifacts live only in a temporary
directory and are removed after the response content is read.

Conversion uses the existing trimesh surface voxelizer without brick
optimization or generation records. VOX has at most 255 colors, QB writes one
uncompressed RGBA matrix, BINVOX 1 writes occupancy only, and XYZRGB writes
six integer values per occupied voxel. The grid is Z-up with normalized
coordinates rather than source units. Interior filling, animation, hierarchy,
transparency, external OBJ materials, and external GLB resources are unsupported.

Uploads are limited to 50 MB, 250,000 mesh faces, 500,000 vertices, and 256 scene
instances. Two isolated conversion processes may run per API process. Processes
are terminated after 90 seconds and Linux workers have a 2 GiB address-space
limit. Clients get a retryable 503 when workers are busy and 422 when a mesh
cannot be converted within the limits.

## Verification and production indexing

Run the frontend tests and build, and the backend mesh export/request tests.
Check desktop and mobile layouts and download an OBJ/GLB conversion. After
merging the PR and deploying **both** services, verify that each public URL
serves its own rendered HTML, and that `/sitemap.xml` includes all eight routes.
Then resubmit `https://brickbuilder.ai/sitemap.xml` in the verified
`sc-domain:brickbuilder.ai` Search Console property. Inspect live VOX URLs and
request indexing if available. Google cannot inspect new production content
before it is deployed, and sitemap submission does not guarantee indexing.

Format references: [MagicaVoxel specification](https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox.txt),
[BINVOX specification](https://www.patrickmin.com/binvox/binvox.html),
[Qubicle Binary specification](https://www.minddesk.com/qb_spec.html).
Google's [sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
explains submission and discovery.
