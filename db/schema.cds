
namespace db;



using {cuid,managed} from '@sap/cds/common';

type Qty :Decimal(13,3);

type StockType:String(12) enum {Unrestricted;Quality;Blocked}


type MovementType:String(14) enum{
    Receipt;Issue;Transfer_Out;Transfer_In;Adjustment;Reversal;
}


type TransferStatus:String(18) enum{
    Requested;Approved;In_Transit;Partially_Received;Completed;Cancelled;
}

type ReservationStatus :String(10) enum {Active;Released;Consumed}


entity UnitOfMeasure{
    key Code:String(3);
    name:String(40)
}


entity Plants{
    key code:String(4);
    name:String(60);
   locations:Composition of many StorageLocations on locations.plant=$self
}

entity StorageLocations{
    key ID:String(12);
    plant:Association to Plants;
    name:String(60);
    bins:Composition of many StorageBins on bins.location=$self
}

entity Materials{
    key ID:String(18);
    description:String(100);
    batchManaged:Boolean default false;
    baseUnit:Association to UnitOfMeasure
}

entity StorageBins: cuid{
    location :Association to StorageLocations;
    code:String(10);
    description:String(60);
}


entity MovementReasons{
    key code:String(10);
    description:String(80);
    category:String(12) enum{ Adjustment;Discrepancy;Reversal}
}


entity ReorderLevels{
    key material:Association to Materials;
    key plant:Association to Plants;
    level:Qty;
}









@assert.unique:{ idempotency:[idempotencykey]}
entity StockMovements :cuid{
    reference:String(24);
    movementType:MovementType;
    material:Association to db.Materials;
    plant:Association to db.Plants;
    location:Association to db.StorageLocations;
    batch:String(10) ;
    stockType:StockType;
    quantity:Qty;
    unit:Association to db.UnitOfMeasure;
    reason:Association to db.MovementReasons;
    reasonText:String(255);
    transfer:Association to TransferRequests;
    transferItem:Association to TransferItems;
    reversalOf:Association to StockMovements;
    idempotencykey:String(80);
    postedBy:String(255);
    postedAt:Timestamp;
}
@assert.unique: { number: [number] }
entity TransferRequests:cuid,managed{

number:String(20);
fromPlant:Association to db.Plants;
fromLocation:Association to db.StorageLocations;
toPlant:Association to db.Plants;
toLocation:Association to db.StorageLocations;
status:TransferStatus default 'Requested';
remarks: String(255);
approvedBy:String(255);
approvedAt:Timestamp;
items:Composition of many TransferItems on items.transfer=$self
}


entity TransferItems:cuid{

    transfer:Association to TransferRequests;
    material:Association to db.Materials;
    batch:String(10) default '';
    unit :Association to db.UnitOfMeasure;
    requestedQty:Qty;
    dispatchedQty:Qty default 0;
    receivedQty:Qty default 0;
    damagedQty:Qty default 0;
    shortageQty:Qty default 0;
    cancelledQty:Qty default 0;
    discrepancyReason:Association to db.MovementReasons;
}

entity Reservations:cuid,managed{
     material:Association to db.Materials;
     plant:Association to db.Plants;
     location :Association to db.StorageLocations;
     batch:String(10) ;
     quantity:Qty;
     consumedQty:Qty default 0;
     releasedQty:Qty default 0;
     status:ReservationStatus default 'Active';
 transferItem:Association to TransferItems;
 note:String(255);
 idempotencykey:String(80);
}

entity Alerts:cuid,managed{
    type:String(20);
    severity:String(8);
    plant:Association to db.Plants;
    material:Association to db.Materials;
    transfer:Association to TransferRequests;
    message:String(500);
    acknowledged:Boolean default  false;

}
entity StockBalances{
     key material:Association to db.Materials;
     key plant:Association to db.Plants;
     key location :Association to db.StorageLocations;
     key batch:String(10) default '' ;
      unrestricted:Qty default 0;
      qualityInspection:Qty default 0;
      blocked:Qty default 0;
      reserved :Qty default 0;
      available:Qty =unrestricted - reserved;
      version: Integer default 0;
      modifiedAt:Timestamp @cds.on.insert:$now @cds.on.update:$now;
      reservations:Association to many Reservations on 
                    reservations.material=$self.material
                   and reservations.plant=$self.plant
                   and reservations.location=$self.location
                   and reservations.batch=$self.batch;
    movements:Association to many StockMovements 
              on movements.material=$self.material
              and movements.plant=$self.plant
              and movements.location=$self.location
              and movements.batch=$self.batch

}


