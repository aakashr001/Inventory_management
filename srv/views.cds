
using { db } from '../db/schema';

namespace views;

// Stock summary per material and plant
entity StockSummary as select from db.StockBalances {
    key material.ID as material : String(18),
    key plant.code as plant : String(4),

    sum(unrestricted) as unrestricted : Decimal(13,3),
    sum(qualityInspection) as qualityInspection : Decimal(13,3),
    sum(blocked) as blocked : Decimal(13,3),
    sum(reserved) as reserved : Decimal(13,3),

    sum(unrestricted - reserved) as available : Decimal(13,3)
}
group by material.ID, plant.code;


// Reorder candidates per material and plant
entity ReorderCandidates as
    select from db.StockBalances as b
    inner join db.ReorderLevels as r
        on r.material.ID = b.material.ID
        and r.plant.code = b.plant.code
{
    key b.material.ID as material : String(18),
    key b.plant.code as plant : String(4),

    r.level as reorderLevel : Decimal(13,3),

    sum(b.unrestricted - b.reserved) as available : Decimal(13,3)
}
group by b.material.ID, b.plant.code, r.level
having sum(b.unrestricted - b.reserved) <= r.level;
