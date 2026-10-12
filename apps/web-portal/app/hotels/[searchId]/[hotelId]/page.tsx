'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PolicyBadge } from '@/components/PolicyBadge';
import { Shell } from '@/components/Shell';
import { api, BOARD_LABEL, HotelResult, HotelSearchRequest, RoomOffer } from '@/lib/api';
import { formatMoney } from '@/lib/format';

interface RoomsResponse {
  hotel: HotelResult;
  request: HotelSearchRequest;
  nights: number;
  offers: RoomOffer[];
}

export default function HotelRoomsPage() {
  const { searchId, hotelId } = useParams<{ searchId: string; hotelId: string }>();
  const router = useRouter();
  const [data, setData] = useState<RoomsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<RoomsResponse>(`/hotels/searches/${searchId}/hotels/${hotelId}`)
      .then(setData)
      .catch((e) => setError(e.code === 'OFFER_EXPIRED' ? 'These prices have expired. Please search again.' : e.message));
  }, [searchId, hotelId]);

  function choose(offer: RoomOffer) {
    if (!data) return;
    sessionStorage.setItem('tripwise.hotelOffer', JSON.stringify({ offer, hotel: data.hotel, request: data.request, nights: data.nights }));
    router.push('/hotels/book');
  }

  return (
    <Shell>
      {error && <div className="alert bad">{error}</div>}
      {data && (
        <>
          <div className="page-head">
            <div>
              <h1>{data.hotel.name}</h1>
              <p className="muted small" style={{ margin: 0 }}>
                {'★'.repeat(data.hotel.stars)} · {data.hotel.address} · {data.request.checkIn} to {data.request.checkOut} ({data.nights}{' '}
                nights, {data.request.rooms.length} room{data.request.rooms.length > 1 ? 's' : ''})
              </p>
            </div>
          </div>
          <div className="stack">
            {data.offers.map((o) => (
              <div className="card offer" key={o.rateId}>
                <div>
                  <h2 style={{ marginBottom: 4 }}>{o.roomName}</h2>
                  <div className="tags" style={{ marginTop: 0 }}>
                    <span className="tag">{BOARD_LABEL[o.board] ?? o.board}</span>
                    {o.refundable ? (
                      <span className="tag good">Free cancellation until {o.freeCancellationUntil?.slice(0, 10)}</span>
                    ) : (
                      <span className="tag">Non-refundable</span>
                    )}
                    <PolicyBadge policy={o.policy} />
                  </div>
                </div>
                <div className="price-col">
                  <div className="price">{formatMoney(o.pricing.sell)}</div>
                  <div className="muted small">
                    {!o.policy && <>Your cost {formatMoney(o.pricing.agentCost)} · </>}
                    {formatMoney({ amount: Math.round(o.pricing.sell.amount / data.nights), currency: o.pricing.sell.currency })}
                    /night
                  </div>
                  <button className="btn" style={{ marginTop: 10 }} onClick={() => choose(o)}>
                    Select
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Shell>
  );
}
