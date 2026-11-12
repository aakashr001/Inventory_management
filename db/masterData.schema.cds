
namespace Ms.Data;


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


