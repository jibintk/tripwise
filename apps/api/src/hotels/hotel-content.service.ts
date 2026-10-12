import { Injectable, Logger } from '@nestjs/common';
import { SupplierHotelContent } from '@tripwise/contracts';
import { findMaster, MasterHotel, normalisedName } from '@tripwise/supplier-gateway';
import { DbService } from '../db/db.service';

export interface Hotel {
  id: string;
  name: string;
  city: string;
  stars: number;
  address: string;
  latitude: number;
  longitude: number;
  amenities: string[];
  images: string[];
}

const COLUMNS = `id, name, city, stars, address, latitude, longitude, amenities, images`;

/**
 * Maintains the master hotel list. The first time a supplier shows a property, it is matched to an
 * existing master hotel (same property from another supplier) or becomes a new one; the mapping is
 * stored, so later searches cost one lookup.
 */
@Injectable()
export class HotelContentService {
  private readonly logger = new Logger(HotelContentService.name);

  constructor(private readonly db: DbService) {}

  /** Returns supplierHotelId -> master hotel for every listing, mapping new ones as needed. */
  async resolve(supplier: string, listings: SupplierHotelContent[]): Promise<Map<string, Hotel>> {
    const result = new Map<string, Hotel>();
    if (!listings.length) return result;
    const { rows: known } = await this.db.query<Hotel & { supplier_hotel_id: string }>(
      `SELECT m.supplier_hotel_id, ${COLUMNS.split(', ').map((c) => `h.${c}`).join(', ')}
         FROM hotels.supplier_map m JOIN hotels.hotel h ON h.id = m.hotel_id
        WHERE m.supplier = $1 AND m.supplier_hotel_id = ANY($2)`,
      [supplier, listings.map((l) => l.supplierHotelId)],
    );
    for (const k of known) result.set(k.supplier_hotel_id, k);

    const unmapped = listings.filter((l) => !result.has(l.supplierHotelId));
    for (const listing of unmapped) {
      result.set(listing.supplierHotelId, await this.map(supplier, listing));
    }
    return result;
  }

  async get(id: string): Promise<Hotel | undefined> {
    return this.db.one<Hotel>(`SELECT ${COLUMNS} FROM hotels.hotel WHERE id = $1`, [id]);
  }

  async getMany(ids: string[]): Promise<Map<string, Hotel>> {
    const { rows } = await this.db.query<Hotel>(`SELECT ${COLUMNS} FROM hotels.hotel WHERE id = ANY($1)`, [ids]);
    return new Map(rows.map((h) => [h.id, h]));
  }

  private async map(supplier: string, listing: SupplierHotelContent): Promise<Hotel> {
    return this.db.tx(async (client) => {
      // Serialise mapping per city so two concurrent searches cannot create the same hotel twice.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('hotel-map:' || $1))`, [listing.city]);
      const existing = await client.query<{ hotel_id: string }>(
        `SELECT hotel_id FROM hotels.supplier_map WHERE supplier = $1 AND supplier_hotel_id = $2`,
        [supplier, listing.supplierHotelId],
      );
      let hotelId: string | undefined = existing.rows[0]?.hotel_id;
      if (!hotelId) {
        const { rows: candidates } = await client.query<MasterHotel>(
          `SELECT id, name, city, latitude, longitude FROM hotels.hotel WHERE city = $1`,
          [listing.city],
        );
        hotelId = findMaster(listing, candidates)?.id;
        if (!hotelId) {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO hotels.hotel (name, normalised_name, city, stars, address, latitude, longitude, amenities, images)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [
              listing.name,
              normalisedName(listing.name),
              listing.city,
              listing.stars,
              listing.address,
              listing.latitude,
              listing.longitude,
              listing.amenities,
              listing.images,
            ],
          );
          hotelId = rows[0].id;
        } else {
          this.logger.log(`Mapped ${supplier}:${listing.supplierHotelId} "${listing.name}" to existing hotel ${hotelId}`);
        }
        await client.query(
          `INSERT INTO hotels.supplier_map (supplier, supplier_hotel_id, hotel_id, supplier_name) VALUES ($1,$2,$3,$4)`,
          [supplier, listing.supplierHotelId, hotelId, listing.name],
        );
      }
      const { rows } = await client.query<Hotel>(`SELECT ${COLUMNS} FROM hotels.hotel WHERE id = $1`, [hotelId]);
      return rows[0];
    });
  }
}
