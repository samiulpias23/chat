'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, ExternalLink, CheckCircle2, XCircle, PauseCircle, Loader2, LogOut } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { formatAppDate } from '@/lib/formatDate';

interface RoomOrder {
  id: string;
  room_id: string;
  user_id: string;
  duration_months: number;
  amount_usd: number;
  tx_hash: string;
  status: 'pending' | 'held' | 'approved' | 'rejected';
  created_at: string;
  rooms?: { name: string; status: string };
}

export default function AdminDashboardPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<RoomOrder[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const fetchOrders = async () => {
    try {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();

      if (user?.app_metadata?.role !== 'admin') {
        router.push('/admin/login');
        return;
      }

      const { data, error } = await supabase
        .from('room_orders')
        .select('*, rooms(name, status)')
        .order('created_at', { ascending: false });

      if (!error && data) {
        setOrders(data as RoomOrder[]);
      }
    } catch (err) {
      console.error('Failed to load orders:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchOrders();
  }, []);

  const handleApprove = async (orderId: string) => {
    setActionLoadingId(orderId);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc('approve_room_order', {
        p_order_id: orderId,
        p_admin_notes: 'Approved via Admin Dashboard',
      });
      if (error) throw error;
      await fetchOrders();
    } catch (err: any) {
      alert(err.message || 'Approval failed.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleSetStatus = async (orderId: string, status: 'held' | 'rejected') => {
    setActionLoadingId(orderId);
    try {
      const supabase = createClient();
      const { error } = await supabase.rpc('set_order_status', {
        p_order_id: orderId,
        p_status: status,
        p_admin_notes: `Marked as ${status} by admin`,
      });
      if (error) throw error;
      await fetchOrders();
    } catch (err: any) {
      alert(err.message || 'Status update failed.');
    } finally {
      setActionLoadingId(null);
    }
  };

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/admin/login');
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#242F3D] pb-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#5288C1] text-white">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">Admin Governance Dashboard</h1>
            <p className="text-xs text-[#7E90A3]">BSC BEP20 Room Purchases & Orders</p>
          </div>
        </div>

        <button
          onClick={handleSignOut}
          className="flex items-center gap-1.5 rounded-xl bg-[#242F3D] px-3 py-2 text-xs text-[#7E90A3] hover:text-white"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign Out
        </button>
      </div>

      {/* Orders Table */}
      <div className="mt-6">
        {isLoading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-[#5288C1]" />
          </div>
        ) : orders.length === 0 ? (
          <div className="rounded-2xl bg-[#17212B] p-8 text-center text-[#7E90A3] border border-[#242F3D]">
            <p className="text-sm">No room orders placed yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {orders.map((order) => {
              const isProcessing = actionLoadingId === order.id;

              return (
                <div
                  key={order.id}
                  className="rounded-2xl bg-[#17212B] p-4 border border-[#242F3D] shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4"
                >
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">
                        {order.rooms?.name || 'Unknown Room'}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                          order.status === 'approved'
                            ? 'bg-[#4ADE80]/20 text-[#4ADE80]'
                            : order.status === 'rejected'
                            ? 'bg-red-500/20 text-red-400'
                            : order.status === 'held'
                            ? 'bg-amber-500/20 text-amber-400'
                            : 'bg-[#5288C1]/20 text-[#5288C1]'
                        }`}
                      >
                        {order.status}
                      </span>
                    </div>

                    <p className="text-xs text-[#7E90A3]">
                      Duration: <strong className="text-white">{order.duration_months} mo</strong> (${order.amount_usd} USD) · Created: {formatAppDate(order.created_at)}
                    </p>

                    <div className="flex items-center gap-1 text-xs">
                      <span className="text-[#7E90A3]">TxID:</span>
                      <a
                        href={`https://bscscan.com/tx/${order.tx_hash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 font-mono text-[#5288C1] hover:underline"
                      >
                        <span className="truncate max-w-[200px] md:max-w-xs">{order.tx_hash}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                    </div>
                  </div>

                  {/* Actions */}
                  {order.status === 'pending' || order.status === 'held' ? (
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleApprove(order.id)}
                        disabled={isProcessing}
                        className="flex items-center gap-1 rounded-xl bg-[#4ADE80] px-3.5 py-2 text-xs font-medium text-black transition hover:bg-[#3ec470] disabled:opacity-50"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Approve
                      </button>

                      {order.status === 'pending' && (
                        <button
                          onClick={() => handleSetStatus(order.id, 'held')}
                          disabled={isProcessing}
                          className="flex items-center gap-1 rounded-xl bg-amber-500/20 px-3 py-2 text-xs font-medium text-amber-300 hover:bg-amber-500/30 disabled:opacity-50"
                        >
                          <PauseCircle className="h-3.5 w-3.5" />
                          Hold
                        </button>
                      )}

                      <button
                        onClick={() => handleSetStatus(order.id, 'rejected')}
                        disabled={isProcessing}
                        className="flex items-center gap-1 rounded-xl bg-red-500/20 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-500/30 disabled:opacity-50"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Reject
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-[#7E90A3] italic">Completed</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
