
using{Ms.Data as dbM} from '../db/masterData.schema';
using {ts.Data as dbt} from '../db/transactionalData';
using {views } from './views';

type DispatchLine {
  item           : UUID;      
  quantity       : dbt.Qty;    
  closeRemaining : Boolean;  
}

type ReceiptLine {
  item          : UUID;       
  receivedQty   : dbt.Qty;     
  damagedQty    : dbt.Qty;     
  closeShortage : Boolean;    
  reasonCode    : String(10); 
}

service IventoryService{
    // Master data
    entity Materials as projection on dbM.Materials;
    entity Plants as projection on dbM.Plants excluding {locations};
    entity StorageLocations as projection on dbM.StorageLocations excluding{bins};
    entity StorageBins as projection on dbM.StorageBins;
    entity UnitsofMeasure as projection on dbM.UnitOfMeasure;
   
    entity MovementReasons as projection on dbM.MovementReasons;
    entity ReorderLevels as projection on dbM.ReorderLevels;

// stock 
  @readonly
  entity StockBalances as projection on dbt.StockBalances
    {*,virtual null as availabilityCriticality:Integer } actions{
        action reserve(quantity:dbt.Qty,note:String(255),idempotencykey:String(80))  returns Reservations;

    }
  @readonly entity StockSummary as projection on views.StockSummary;
  @readonly entity ReorderCandidates as projection on views.ReorderCandidates;
@readonly 
entity StockMovements as projection on dbt.StockMovements actions{
    action reverseMovement(reasonCode:String(10),reasonText:String(255),idempotencykey:String(80)) returns StockMovements;
}


@readonly
entity Reservations as projection on dbt.Reservations actions{
    action releaseReservation() returns Reservations;
}

// transfer 
entity TransferRequests as projection on dbt.TransferRequests
{*,virtual null as statusCriticality :Integer } actions{
    action approveTransfer() returns TransferRequests;
    action cancelTransfer() returns TransferRequests;
    action dispacthTransfer(items:many DispatchLine,idempotencykey:String(80)) returns TransferRequests;

    action receiveTransfer (items:many ReceiptLine,idempotencykey:String(80)) returns TransferRequests
}

entity TransferItems as projection on dbt.TransferItems;

// exceptions

entity Alerts as projection on dbt.Alerts

}