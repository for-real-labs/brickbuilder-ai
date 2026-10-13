# Order cancellation

`orders.cancelled` defaults to `false`. Administrators can set it in the
generations viewer's order editor. Existing database update policies remain in
force; customers cannot cancel orders through the dashboard.

Cancelled orders appear grey in the viewer and as a grey **Cancelled** badge in
BrickBuilder's My Orders page. The existing fulfilled and processing states
remain available. The database rejects an order with both `cancelled = true`
and `fulfilled = true`; select another state before saving.

Cancellation preserves the order, amount paid, and payment references. It does
not initiate a refund, cancel a supplier purchase, or remove the saved model.
For a replacement model, associate its `user_id` and `user_type` with the original
creator so the generation and its order appear in that creator's account.
