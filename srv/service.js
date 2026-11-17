



const cds = require("@sap/cds");
const { results } = require("@sap/cds/lib/utils/cds-utils");

const { SELECT, INSERT, UPDATE } = cds.ql;


module.exports = cds.service.impl(async function() {

    const {
        StockBalances,
        StockMovements,
        Reservations,
        TransferRequests,
        TransferItems,
        Alerts,ReorderLevels,
        StorageLocations,
        Materials
    } = this.entities

    

    // COMMON HELPER FUNCTIONS
    
 const fail = (req, status, message) =>
        req.reject(status, message);
    const setTransferStatus = async (tx, transferID, status) => {
      await tx.run(
        UPDATE(TransferRequests)
          .set({ status })
          .where({ ID: transferID })
      );
    };
   const number = (value) => Number(value || 0);

        const currentUser = (req) => {
        return req.user?.id || "SYSTEM";
    };
   const insertMovement = async (tx, req, data) => {
      if (!data.idempotencykey) {
        fail(req, 400, "An idempotency key is required.");
      }

      const existing = await tx.run(
        SELECT.one.from(StockMovements).where({
          idempotencykey: data.idempotencykey
        })
      );
 

      if (existing) return existing;

      const movement = {
        reference: data.reference || `MOV-${Date.now()}`,
        movementType: data.movementType,
        material_ID: data.material,
        plant_code: data.plant,
        location_ID: data.location,
        batch: data.batch,
        stockType: data.stockType || "Unrestricted",
        quantity: data.quantity,
        unit_Code: data.unit,
        reason_code: data.reason || null,
        reasonText: data.reasonText || null,
        transfer_ID: data.transfer || null,
        transferItem_ID: data.transferItem || null,
        reversalOf_ID: data.reversalOf || null,
        idempotencykey: data.idempotencykey,
        postedBy: currentUser(req),
        postedAt: new Date().toISOString()
      };

      await tx.run(
        INSERT.into(StockMovements).entries(movement)
      );

      return movement;
    };

   

   const updateTransferStatusFromItems = async (
      tx,
      transferID
    ) => {
      const items = await getTransferItems(tx, transferID);

      if (!items.length) return;

      const allDispatched = items.every(
        (i) =>
          number(i.dispatchedQty) + number(i.cancelledQty) >=
          number(i.requestedQty)
      );

      const allReceived = items.every(
        (i) =>
          number(i.receivedQty) +
            number(i.damagedQty) +
            number(i.shortageQty) >=
          number(i.dispatchedQty)
      );

      const anyDispatched = items.some(
        (i) => number(i.dispatchedQty) > 0
      );

      const anyReceived = items.some(
        (i) =>
          number(i.receivedQty) +
            number(i.damagedQty) +
            number(i.shortageQty) >
          0
      );

      if (allDispatched && allReceived) {
        await setTransferStatus(tx, transferID, "Completed");
      } else if (anyReceived) {
        await setTransferStatus(
          tx,
          transferID,
          "Partially_Received"
        );
      } else if (anyDispatched) {
        await setTransferStatus(
          tx,
          transferID,
          "In_Transit"
        );
      }
    };
    // Validate positive quantity

    const requirePositive = (req, value, fieldName) => {

        if (
            value === null ||
            value === undefined ||
            value === "" ||
            !Number.isFinite(Number(value)) ||
            Number(value) <= 0
        ) {
            fail(req, 400, `${fieldName} must be greater than zero.`);
        }

    };


const assertPlantAccess = (req, plantCode) => {
    const assignedPlants = req.user?.attr?.plants;

    if (
        !Array.isArray(assignedPlants) ||
        assignedPlants.length === 0
    ) {
        fail(req, 403, "No plants are assigned to this user.");
    }

    if (!assignedPlants.includes(plantCode)) {
        fail(
            req,
            403,
            "You are not authorized to access this plant."
        );
    }
};
    

    // Get stock balance

    const getStock = async (tx, key, req) => {

        const stock = await tx.run(
            SELECT.one.from(StockBalances)
                .where(key)
                .forUpdate()
        );

        if (!stock) {
            fail(req, 404, "Stock balance was not found.");
        }

        return stock;

    };


    // Validate stock balance quantities

    const validateStock = (req, stock) => {

        const unrestricted = number(stock.unrestricted);
        const reserved = number(stock.reserved);
        const blocked = number(stock.blocked);

        if (
            unrestricted < 0 ||
            reserved < 0 ||
            blocked < 0
        ) {
            fail(req, 409, "Stock quantities cannot be negative.");
        }

        if (reserved > unrestricted) {
            fail(
                req,
                409,
                "Reserved quantity cannot exceed unrestricted stock."
            );
        }

    };


    // Update stock balance

    const updateStock = async (tx, stock, changes, req) => {

        const result = await tx.run(
            UPDATE(StockBalances)
                .set({
                    ...changes,
                    version: number(stock.version) + 1
                })
                .where({
                    material_ID: stock.material_ID,
                    plant_code: stock.plant_code,
                    location_ID: stock.location_ID,
                    batch: stock.batch,
                    version: number(stock.version)
                })
        );

        if (result === 0) {
            fail(
                req,
                409,
                "Stock was changed by another user. Refresh and try again."
            );
        }

    };

//  create transfer request life cycle 1 the business process

this.on("createTransfer",async(req)=>{
     
  const {fromPlant,fromLocation,toPlant,toLocation,remarks,items}=req.data
  const tx=cds.tx(req)

  if(!fromPlant || !fromLocation || !toPlant ||!toLocation){
    fail(req,400,"From and to plant /location are required")
  }
  

  if(fromPlant===toPlant&& fromLocation===toLocation){
    fail(req,400,"Source and destination must be different")
  }

  if(!items?.length) fail(req,400,"A transfer needs at least one item")

// locations should match their respective plants

const from=await tx.run(SELECT.one.from(StorageLocations).where({ID:fromLocation }))
const to =await tx.run(SELECT.one.from(StorageLocations).where({ ID:toLocation }))

if(!from || from.plant_code !==fromPlant) fail(req,400,"Source location is not in the source plant")
if(!to || to.plant_code !==toPlant) fail(req,400,"Destination location is not in the destination plant")

  // to inject the items also 

  const transferID=cds.utils.uuid()
  const itemRows=[]
  for(const item of items){
    requirePositive(req,item.requestedQty,"Requested Quantity");
    const material= await tx.run(SELECT.one.from(Materials).where({
      ID:item.material
    }))

    if(!material) fail(req,400,`Unknown material ${item.material}.`)

      itemRows.push({
          ID:cds.utils.uuid(),
          material_ID:item.material,
          batch:item.batch,
          unit_Code:item.unit ||material.baseUnit_Code,
          requestedQty:number(item.requestedQty)
          // 
      })
  }

//  now we are going to create ransaction number 

const last =await tx.run(SELECT.one.from(TransferRequests).columns('number').orderBy('number desc'))

const next =last ? parseInt(last.number.slice(3))+1 : 1001 


// save header +items together 

await tx.run(INSERT.into(TransferRequests).entries({
  ID:transferID,
  number:`TR-${next}`,
  fromPlant_code:fromPlant,
  fromLocation_ID:fromLocation,
  toPlant_code:toPlant,
  toLocation_ID:toLocation,
  status:'Requested',
  remarks:remarks || '',
  items:itemRows
}))

// final output 

const result =await tx.run(SELECT.one.from(TransferRequests).where({ID:transferID}));
results.items=await tx.run(SELECT.from(TransferItems).where({transfer_ID:transferID}))
 return result ;

})











    // stock reservation
   

    // this.on("reserve", "StockBalances", async (req) => {

    //     const {
    //         quantity,
    //         note,
    //         idempotencykey
    //     } = req.data;

    //     // Validate reservation quantity

    //     requirePositive(req, quantity, "Reservation quantity");


    //     //  Validate idempotency key

    //     if (
    //         !idempotencykey ||
    //         !String(idempotencykey).trim()
    //     ) {
    //         fail(req, 400, "Idempotency key is required.");
    //     }


    //     //  Start request transaction

    //     const tx = cds.tx(req);


    //     //  Check duplicate reservation request

    //     const existing = await tx.run(
    //         SELECT.one.from(Reservations).where({
    //             idempotencykey
    //         })
    //     );

    //     if (existing) {

    //         // Same key cannot be reused for a different request

    //         if (
    //             number(existing.quantity) !== number(quantity)
    //         ) {
    //             fail(
    //                 req,
    //                 409,
    //                 "Idempotency key was already used with a different quantity."
    //             );
    //         }

    //         return existing;
    //     }


    //     //  Get stock balance key from request

    //     const keyParams = req.params?.[0] || undefined;

    //     const key = {
    //         material_ID: keyParams.material_ID,
    //         plant_code: keyParams.plant_code,
    //         location_ID: keyParams.location_ID,
    //         batch: keyParams.batch
    //     };


    //     //  Validate stock balance key

    //     if (
    //         !key.material_ID ||
    //         !key.plant_code ||
    //         !key.location_ID
    //     ) {
    //         fail(
    //             req,
    //             400,
    //             "Material, plant and storage location are required."
    //         );
    //     }


    //     //  Get and lock stock balance

    //     const stock = await getStock(tx, key, req);


    //     //  Check user plant authorization

    


    //     //  Validate existing stock quantities

    //     validateStock(req, stock);
            
    //     //  Check available stock
    //     const available = number(stock.unrestricted) - number(stock.reserved);

    //     if (number(quantity) > available) {

    //         fail(
    //             req,
    //             400,
    //             `Insufficient stock. Available quantity: ${available}.`
    //         );

    //     }


    //     //  Create reservation

    //     const reservationID = cds.utils.uuid();

    //     await tx.run(
    //         INSERT.into(Reservations).entries({

    //             ID: reservationID,

    //             material_ID: stock.material_ID,
    //             plant_code: stock.plant_code,
    //             location_ID: stock.location_ID,
    //             batch: stock.batch,

    //             quantity: number(quantity),
    //             consumedQty: 0,
    //             releasedQty: 0,

    //             status: "Active",

    //             note: note || "",
    //             idempotencykey: idempotencykey

    //         })
    //     );


    //     //  Increase reserved stock quantity

    //     await updateStock(
    //         tx,
    //         stock,
    //         {
    //             reserved:
    //                 number(stock.reserved) + number(quantity)
    //         },
    //         req
    //     );


    //     //  Return created reservation

    //     return tx.run(
    //         SELECT.one.from(Reservations).where({
    //             ID: reservationID
    //         })
    //     );

    // });


    // RELEASE RESERVATION


    this.on("releaseReservation", "Reservations", async (req) => {

        const reservationID = req.params?.[0]?.ID;

        //  Validate reservation ID

        if (!reservationID) {
            fail(req, 400, "Reservation ID is required.");
        }


        const tx = cds.tx(req);


        //  Get reservation and lock it

        const reservation = await tx.run(
            SELECT.one.from(Reservations)
                .where({ ID: reservationID })
                .forUpdate()
        );


        //  Check reservation exists

        if (!reservation) {
            fail(req, 404, "Reservation was not found.");
        }


        //  Only active reservations can be released

        if (reservation.status !== "Active") {

            fail(
                req,
                400,
                "Only active reservations can be released."
            );

        }



       


        //  Calculate remaining reservation quantity

        const remaining =
            number(reservation.quantity) -
            number(reservation.consumedQty) -
            number(reservation.releasedQty);


        //  Validate reservation quantities

        if (remaining < 0) {

            fail(
                req,
                409,
                "Consumed and released quantities cannot exceed reserved quantity."
            );

        }


        //  Get related stock balance

        const key = {

            material_ID: reservation.material_ID,
            plant_code: reservation.plant_code,
            location_ID: reservation.location_ID,
            batch: reservation.batch

        };

        const stock = await getStock(tx, key, req);


        //  Validate stock balance

        validateStock(req, stock);


        //  Check reserved stock before release

        if (number(stock.reserved) < remaining) {

            fail(
                req,
                409,
                "Stock reserved quantity is less than the reservation quantity."
            );

        }


        //  Reduce reserved stock quantity

        await updateStock(
            tx,
            stock,
            {
                reserved:
                    number(stock.reserved) - remaining
            },
            req
        );


        //  Update reservation status

        await tx.run(
            UPDATE(Reservations)
                .set({

                    releasedQty:
                        number(reservation.releasedQty) + remaining,

                    status: "Released"

                })
                .where({
                    ID: reservationID
                })
        );


        //  Return updated reservation

        return tx.run(
            SELECT.one.from(Reservations).where({
                ID: reservationID
            })
        );

    });
    

// second port of brd execution process
// stock movement

// transfer request validation


 
     const getTransferItems = async (tx, transferID) =>
      tx.run(
        SELECT.from(TransferItems).where({
          transfer_ID: transferID
        })
      );
    const getReservationForItem = async (tx, itemID) =>
      tx.run(
        SELECT.from(Reservations).where({
          transferItem_ID: itemID,
          status: "Active"
        })
      );

 const getTransfer = async (tx, transferID, req) => {
    const transfer = await tx.run(
        SELECT.one.from(TransferRequests)
          .where({ ID: transferID })
          .forUpdate()
      );

      if (!transfer) {
        fail(req, 404, "Transfer request was not found.");
      }

      return transfer;
    };

//




// approve transfer and reserve stock
    this.on("approveTransfer", "TransferRequests", async (req) => {
      const transferID = req.params?.[0]?.ID;

      const tx = cds.tx(req);

      const transfer = await getTransfer(
        tx,
        transferID,
        req
      );

    

      if (transfer.status !== "Requested") {
        fail(
          req,
          400,
          "Only requested transfers can be approved."
        );
      }

      const items = await getTransferItems(tx, transferID);

      if (!items.length) {
        fail(req, 400, "Transfer has no items.");
      }

      for (const item of items) {
        requirePositive(
          req,
          item.requestedQty,
          "Requested quantity"
        );

        const key = {
          material_ID: item.material_ID,
          plant_code: transfer.fromPlant_code,
          location_ID: transfer.fromLocation_ID,
          batch: item.batch
        };
console.log(key)
        const stock = await getStock(tx, key, req);

        const available =
          number(stock.unrestricted) -
          number(stock.reserved);

        if (number(item.requestedQty) > available) {
          fail(
            req,
            400,
            `Insufficient stock for material ${item.material_ID}. Available: ${available}.`
          );
        }

        const reservationID = cds.utils.uuid();

        await tx.run(
          INSERT.into(Reservations).entries({
            ID: reservationID,
            material_ID: item.material_ID,
            plant_code: transfer.fromPlant_code,
            location_ID: transfer.fromLocation_ID,
            batch: item.batch,
            quantity: item.requestedQty,
            consumedQty: 0,
            releasedQty: 0,
            status: "Active",
            transferItem_ID: item.ID,
            note: `Transfer ${transfer.number}`,
            idempotencykey: `RES-${transferID}-${item.ID}`
          })
        );

        await updateStock(
          tx,
          stock,
          {
            reserved:
              number(stock.reserved) +
              number(item.requestedQty)
          },
          req
        );
      }

      await tx.run(
        UPDATE(TransferRequests)
          .set({
            status: "Approved",
            approvedBy: currentUser(req),
            approvedAt: new Date().toISOString()
          })
          .where({ ID: transferID })
      );

      return tx.run(
        SELECT.one.from(TransferRequests).where({
          ID: transferID
        })
      );
    });


// cancel transfer and relaes resrvations

    this.on("cancelTransfer", "TransferRequests", async (req) => {
      const transferID = req.params?.[0]?.ID;

      const tx = cds.tx(req);

      const transfer = await getTransfer(
        tx,
        transferID,
        req
      );

    

      if (
        ["Completed", "Cancelled"].includes(transfer.status)
      ) {
        fail(
          req,
          400,
          "Completed or cancelled transfers cannot be cancelled."
        );
      }

      const items = await getTransferItems(tx, transferID);

      for (const item of items) {
        const reservations = await getReservationForItem(
          tx,
          item.ID
        );

        for (const reservation of reservations) {
          const remaining =
            number(reservation.quantity) -
            number(reservation.consumedQty) -
            number(reservation.releasedQty);

          if (remaining <= 0) continue;

          const stock = await getStock(
            tx,
            {
              material_ID: reservation.material_ID,
              plant_code: reservation.plant_code,
              location_ID: reservation.location_ID,
              batch: reservation.batch
            },
            req
          );

          await updateStock(
            tx,
            stock,
            {
              reserved: Math.max(
                0,
                number(stock.reserved) - remaining
              )
            },
            req
          );

          await tx.run(
            UPDATE(Reservations)
              .set({
                releasedQty:
                  number(reservation.releasedQty) + remaining,
                status: "Released"
              })
              .where({ ID: reservation.ID })
          );
        }

        const remainingToDispatch =
          number(item.requestedQty) -
          number(item.dispatchedQty) -
          number(item.cancelledQty);

        if (remainingToDispatch > 0) {
          await tx.run(
            UPDATE(TransferItems)
              .set({
                cancelledQty:
                  number(item.cancelledQty) +
                  remainingToDispatch
              })
              .where({ ID: item.ID })
          );
        }
      }

       const setTransferStatus = async (tx, transferID, status) => {
      await tx.run(
        UPDATE(TransferRequests)
          .set({ status })
          .where({ ID: transferID })
      );
    };


      await setTransferStatus(
        tx,
        transferID,
        "Cancelled"
      );

      return tx.run(
        SELECT.one.from(TransferRequests).where({
          ID: transferID
        })
    );
   
}) 


 this.on("dispacthTransfer", "TransferRequests", async (req) => {
      const transferID = req.params?.[0]?.ID;

      const {
        items: lines,
        idempotencykey
      } = req.data;

      const tx = cds.tx(req);

      if (!idempotencykey) {
        fail(req, 400, "Idempotency key is required.");
      }

      if (!Array.isArray(lines) || !lines.length) {
        fail(req, 400, "At least one dispatch line is required.");
      }

      const transfer = await getTransfer(
        tx,
        transferID,
        req
      );

      // assertPlantAccess(req, transfer.fromPlant_code);

      if (!["Approved", "In_Transit"].includes(transfer.status)) {
        fail(
          req,
          400,
          "Transfer must be approved before dispatch."
        );
      }

      const duplicate = await tx.run(
        SELECT.one.from(StockMovements).where({
          idempotencykey: `DISPATCH-${idempotencykey}`
        })
      );

      if (duplicate) {
        return tx.run(
          SELECT.one.from(TransferRequests).where({
            ID: transferID
          })
        );
      }

      for (const line of lines) {
        requirePositive(
          req,
          line.quantity,
          "Dispatch quantity"
        );

        const item = await tx.run(
          SELECT.one.from(TransferItems)
            .where({
              ID: line.item,
              transfer_ID: transferID
            })
            .forUpdate()
        );

        if (!item) {
          fail(
            req,
            404,
            `Transfer item ${line.item} was not found.`
          );
        }

        const remaining =
          number(item.requestedQty) -
          number(item.dispatchedQty) -
          number(item.cancelledQty);

        if (number(line.quantity) > remaining) {
          fail(
            req,
            400,
            "Dispatch quantity exceeds the remaining requested quantity."
          );
        }

        const reservationRows =
          await getReservationForItem(tx, item.ID);

        const reservation = reservationRows[0];

        if (!reservation) {
          fail(req, 400, "Active reservation was not found.");
        }

        const stock = await getStock(
          tx,
          {
            material_ID: item.material_ID,
            plant_code: transfer.fromPlant_code,
            location_ID: transfer.fromLocation_ID,
            batch:
            item.batch
          },
          req
        );

        if (
          number(stock.unrestricted) <
          number(line.quantity)
        ) {
          fail(
            req,
            400,
            "Insufficient unrestricted stock for dispatch."
          );
        }

        if (
          number(stock.reserved) <
          number(line.quantity)
        ) {
          fail(
            req,
            409,
            "Reserved stock is lower than the dispatch quantity."
          );
        }

        // Reduce source stock and reservation

        await updateStock(
          tx,
          stock,
          {
            unrestricted:
              number(stock.unrestricted) -
              number(line.quantity),

            reserved:
              number(stock.reserved) -
              number(line.quantity)
          },
          req
        );

        const newDispatched =
          number(item.dispatchedQty) +
          number(line.quantity);

        const remainingReservation =
          number(reservation.quantity) -
          number(reservation.consumedQty) -
          number(reservation.releasedQty) -
          number(line.quantity);

        await tx.run(
          UPDATE(Reservations)
            .set({
              consumedQty:
                number(reservation.consumedQty) +
                number(line.quantity),

              status:
                remainingReservation <= 0
                  ? "Consumed"
                  : "Active"
            })
            .where({ ID: reservation.ID })
        );

        await tx.run(
          UPDATE(TransferItems)
            .set({
              dispatchedQty: newDispatched
            })
            .where({ ID: item.ID })
        );

        // Create stock movement ledger entry

        await insertMovement(tx, req, {
          movementType: "Transfer_Out",
          material: item.material_ID,
          plant: transfer.fromPlant_code,
          location: transfer.fromLocation_ID,
          batch: item.batch,
          stockType: "Unrestricted",
          quantity: line.quantity,
          unit: item.unit_Code,
          transfer: transferID,
          transferItem: item.ID,
          idempotencykey:
            `DISPATCH-${idempotencykey}-${item.ID}`
        });

        // Close remaining undispatched quantity

        if (line.closeRemaining) {
          const outstanding =
            remaining - number(line.quantity);

          if (outstanding > 0) {
            const activeReservations =
              await getReservationForItem(tx, item.ID);

            for (const active of activeReservations) {
              const releaseQty =
                number(active.quantity) -
                number(active.consumedQty) -
                number(active.releasedQty);

              if (releaseQty <= 0) continue;

              const latestStock = await getStock(
                tx,
                {
                  material_ID: active.material_ID,
                  plant_code: active.plant_code,
                  location_ID: active.location_ID,
                  batch: active.batch
                },
                req
              );

              await updateStock(
                tx,
                latestStock,
                {
                  reserved: Math.max(
                    0,
                    number(latestStock.reserved) -
                    releaseQty
                  )
                },
                req
              );

              await tx.run(
                UPDATE(Reservations)
                  .set({
                    releasedQty:
                      number(active.releasedQty) +
                      releaseQty,

                    status: "Released"
                  })
                  .where({ ID: active.ID })
              );
            }

            await tx.run(
              UPDATE(TransferItems)
                .set({
                  cancelledQty:
                    number(item.cancelledQty) +
                    outstanding
                })
                .where({ ID: item.ID })
            );
          }
        }
      }

      await updateTransferStatusFromItems(
        tx,
        transferID
      );

      return tx.run(
        SELECT.one.from(TransferRequests).where({
          ID: transferID
        })
      );
    });
 // RECEIVE TRANSFER

    this.on("receiveTransfer", "TransferRequests", async (req) => {
      const transferID = req.params?.[0]?.ID;

      const {
        items: lines,
        idempotencykey
      } = req.data;

      const tx = cds.tx(req);

      if (!idempotencykey) {
        fail(req, 400, "Idempotency key is required.");
      }

      if (!Array.isArray(lines) || !lines.length) {
        fail(req, 400, "At least one receipt line is required.");
      }

      const transfer = await getTransfer(
        tx,
        transferID,
        req
      );

      // assertPlantAccess(req, transfer.toPlant_code);

      if (
        !["In_Transit", "Partially_Received"].includes(
          transfer.status
        )
      ) {
        fail(
          req,
          400,
          "Transfer has no dispatched quantity available for receipt."
        );
      }

      const duplicate = await tx.run(
        SELECT.one.from(StockMovements).where({
          idempotencykey: `RECEIPT-${idempotencykey}`
        })
      );

      if (duplicate) {
        return tx.run(
          SELECT.one.from(TransferRequests).where({
            ID: transferID
          })
        );
      }

      for (const line of lines) {
        const good = number(line.receivedQty);
        const damaged = number(line.damagedQty);

        if (
          good < 0 ||
          damaged < 0 ||
          !Number.isFinite(good + damaged)
        ) {
          fail(
            req,
            400,
            "Received and damaged quantities cannot be negative."
          );
        }

        const item = await tx.run(
          SELECT.one.from(TransferItems)
            .where({
              ID: line.item,
              transfer_ID: transferID
            })
            .forUpdate()
        );

        if (!item) {
          fail(
            req,
            404,
            `Transfer item ${line.item} was not found.`
          );
        }

        const alreadyResolved =
          number(item.receivedQty) +
          number(item.damagedQty) +
          number(item.shortageQty);

        const outstanding =
          number(item.dispatchedQty) -
          alreadyResolved;

        const totalReported = good + damaged;

        if (totalReported > outstanding) {
          fail(
            req,
            400,
            "Receipt quantity exceeds the dispatched quantity still in transit."
          );
        }

        const shortage = outstanding - totalReported;

        if (
          shortage > 0 &&
          line.closeShortage &&
          !line.reasonCode
        ) {
          fail(
            req,
            400,
            "A reason code is required when closing a shortage."
          );
        }

        if (damaged > 0 && !line.reasonCode) {
          fail(
            req,
            400,
            "A reason code is required for damaged goods."
          );
        }

        // Destination stock key

        const destinationKey = {
          material_ID: item.material_ID,
          plant_code: transfer.toPlant_code,
          location_ID: transfer.toLocation_ID,
          batch: item.batch
        };

        let destinationStock = await tx.run(
          SELECT.one.from(StockBalances)
            .where(destinationKey)
            .forUpdate()
        );

        // Create destination stock balance if it does not exist

        if (!destinationStock) {
          await tx.run(
            INSERT.into(StockBalances).entries({
              ...destinationKey,
              unrestricted: 0,
              qualityInspection: 0,
              blocked: 0,
              reserved: 0,
              version: 0
            })
          );

          destinationStock = await getStock(
            tx,
            destinationKey,
            req
          );
        }

        // Good stock -> unrestricted
        // Damaged stock -> blocked

        await updateStock(
          tx,
          destinationStock,
          {
            unrestricted:
              number(destinationStock.unrestricted) + good,

            blocked:
              number(destinationStock.blocked) + damaged
          },
          req
        );

        // Good quantity movement

        if (good > 0) {
          await insertMovement(tx, req, {
            movementType: "Transfer_In",
            material: item.material_ID,
            plant: transfer.toPlant_code,
            location: transfer.toLocation_ID,
            batch: item.batch,
            stockType: "Unrestricted",
            quantity: good,
            unit: item.unit_Code,
            transfer: transferID,
            transferItem: item.ID,
            idempotencykey:
              `RECEIPT-${idempotencykey}-${item.ID}-GOOD`
          });
        }

        // Damaged quantity movement

        if (damaged > 0) {
          await insertMovement(tx, req, {
            movementType: "Transfer_In",
            material: item.material_ID,
            plant: transfer.toPlant_code,
            location: transfer.toLocation_ID,
            batch: item.batch,
            stockType: "Blocked",
            quantity: damaged,
            unit: item.unit_Code,
            reason: line.reasonCode,
            reasonText: "Damaged during transfer receipt",
            transfer: transferID,
            transferItem: item.ID,
            idempotencykey:
              `RECEIPT-${idempotencykey}-${item.ID}-DAMAGED`
          });
        }

        // Close shortage only when requested

        const shortageToClose =
          line.closeShortage && shortage > 0
            ? shortage
            : 0;

        await tx.run(
          UPDATE(TransferItems)
            .set({
              receivedQty:
                number(item.receivedQty) + good,

              damagedQty:
                number(item.damagedQty) + damaged,

              shortageQty:
                number(item.shortageQty) + shortageToClose,

              ...(shortageToClose > 0
                ? {
                    discrepancyReason_code: line.reasonCode
                  }
                : {})
            })
            .where({ ID: item.ID })
        );

        // Create discrepancy alert

        if (damaged > 0 || shortageToClose > 0) {
          await createAlert(tx, {
            type: "TransferDiscrepancy",
            severity: "High",
            plant: transfer.toPlant_code,
            material: item.material_ID,
            transfer: transferID,

            message:
              `Transfer ${transfer.number}: damaged ${damaged}, ` +
              `shortage ${shortageToClose}. Reason: ` +
              `${line.reasonCode || "Not supplied"}.`
          });
        }
      }

      await updateTransferStatusFromItems(
        tx,
        transferID
      );

      return tx.run(
        SELECT.one.from(TransferRequests).where({
          ID: transferID
        })
      );
    });

     this.on("reverseMovement", "StockMovements", async (req) => {
      const movementID = req.params?.[0]?.ID;

      const {
        reasonCode,
        reasonText,
        idempotencykey
      } = req.data;

      const tx = cds.tx(req);

      if (!reasonCode) {
        fail(req, 400, "A reversal reason is required.");
      }

      if (!idempotencykey) {
        fail(req, 400, "Idempotency key is required.");
      }

      const duplicate = await tx.run(
        SELECT.one.from(StockMovements).where({
          idempotencykey
        })
      );

      if (duplicate) return duplicate;

      const original = await tx.run(
        SELECT.one.from(StockMovements)
          .where({ ID: movementID })
          .forUpdate()
      );

      if (!original) {
        fail(req, 404, "Original movement was not found.");
      }

      const alreadyReversed = await tx.run(
        SELECT.one.from(StockMovements).where({
          reversalOf_ID: movementID
        })
      );

      if (alreadyReversed) {
        fail(req, 409, "This movement has already been reversed.");
      }

      const key = {
        material_ID: original.material_ID,
        plant_code: original.plant_code,
        location_ID: original.location_ID,
        batch: original.batch
      };

      const stock = await getStock(tx, key, req);

      const qty = number(original.quantity);

      let changes = {};

      const stockField =
        original.stockType === "Quality"
          ? "qualityInspection"
          : original.stockType === "Blocked"
            ? "blocked"
            : "unrestricted";

      if (
        original.movementType === "Receipt" ||
        original.movementType === "Transfer_In"
      ) {
        if (number(stock[stockField]) < qty) {
          fail(
            req,
            400,
            "Cannot reverse movement: insufficient current stock."
          );
        }

        changes[stockField] =
          number(stock[stockField]) - qty;

      } else if (
        original.movementType === "Issue" ||
        original.movementType === "Transfer_Out"
      ) {
        changes[stockField] =
          number(stock[stockField]) + qty;

      } else {
        fail(
          req,
          400,
          "Automatic reversal is supported for Receipt, Issue and transfer movements only."
        );
      }

      await updateStock(tx, stock, changes, req);

      await insertMovement(tx, req, {
        movementType: "Reversal",
        material: original.material_ID,
        plant: original.plant_code,
        location: original.location_ID,
        batch: original.batch,
        stockType: original.stockType,
        quantity: qty,
        unit: original.unit_Code,
        reason: reasonCode,
        reasonText,
        reversalOf: movementID,
        idempotencykey
      });

      return tx.run(
        SELECT.one.from(StockMovements).where({
          idempotencykey
        })
      );
    });


})
