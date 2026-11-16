
using {db } from '../db/schema';

using {views } from './views';

type TransferItemInput{
  material :String(18);
  batch:String(10);
  unit:String(10);
  requestedQty:db.Qty;

}

type DispatchLine {
  item           : UUID;      
  quantity       : db.Qty;    
  closeRemaining : Boolean;  
}

type ReceiptLine {
  item          : UUID;       
  receivedQty   : db.Qty;     
  damagedQty    : db.Qty;     
  closeShortage : Boolean;    
  reasonCode    : String(10); 
}


service InventoryService{
    // Master data
    entity Materials as projection on db.Materials;
    entity Plants as projection on db.Plants excluding {locations};
    entity StorageLocations as projection on db.StorageLocations excluding{bins};
    entity StorageBins as projection on db.StorageBins;
    entity UnitsofMeasure as projection on db.UnitOfMeasure;
   
    entity MovementReasons as projection on db.MovementReasons;
    entity ReorderLevels as projection on db.ReorderLevels;

// stock 
  @readonly
  entity StockBalances as projection on db.StockBalances
    {*,virtual null as availabilityCriticality:Integer } actions{
        action reserve(quantity:db.Qty,note:String(255),idempotencykey:String(80))  returns Reservations;

    }
  @readonly entity StockSummary as projection on views.StockSummary;
  // 
@readonly 
entity StockMovements as projection on db.StockMovements actions{
    action reverseMovement(reasonCode:String(10),reasonText:String(255),idempotencykey:String(80)) returns StockMovements;
}


@readonly
entity Reservations as projection on db.Reservations actions{
    action releaseReservation() returns Reservations;
}

// transfer 
entity TransferRequests as projection on db.TransferRequests
 actions{
    action approveTransfer() returns TransferRequests;
    action cancelTransfer() returns TransferRequests;
    action dispacthTransfer(items:many DispatchLine,idempotencykey:String(80)) returns TransferRequests;

    action receiveTransfer (items:many ReceiptLine,idempotencykey:String(80)) returns TransferRequests
}


entity TransferItems as projection on db.TransferItems;

// exceptions

entity Alerts as projection on db.Alerts;

action createTransfer(
 fromPlant:String(4),
 fromLocation:String(12),
 toPlant:String(12),
 toLocation:String(12),
 remarks:String(255),
 items:many TransferItemInput

) returns TransferRequests
 

}