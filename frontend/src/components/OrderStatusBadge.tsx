import React from 'react';
import { CheckCircle2, Truck, XCircle } from 'lucide-react';
import type { OrderInfo } from '../services/getUserGenerationsApi';

export function OrderStatusBadge({ order }: { order: Pick<OrderInfo, 'fulfilled' | 'cancelled'> }) {
  const status = order.cancelled
    ? { label: 'Cancelled', color: 'bg-slate-100 text-slate-600', Icon: XCircle }
    : order.fulfilled
      ? { label: 'Fulfilled', color: 'bg-green-100 text-green-700', Icon: CheckCircle2 }
      : { label: 'Processing', color: 'bg-yellow-100 text-yellow-700', Icon: Truck };
  const Icon = status.Icon;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${status.color}`}>
      <Icon className="w-3.5 h-3.5" aria-hidden="true" /> {status.label}
    </span>
  );
}
