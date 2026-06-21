import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from "typeorm"
import { Company } from "./Company"
import { Product } from "./Product"

@Entity("company_product_discount")
@Index(["company_id"])
@Index(["product_id"])
@Index(["company_id", "product_id"], { unique: true })
export class CompanyProductDiscount {
  @PrimaryGeneratedColumn()
  company_product_discount_id!: number

  @Column({ type: "int" })
  company_id!: number

  @Column({ type: "int" })
  product_id!: number

  @Column({ type: "decimal", precision: 5, scale: 2 })
  discount_percentage!: number

  @CreateDateColumn({ name: "created_at" })
  created_at!: Date

  @UpdateDateColumn({ name: "updated_at" })
  updated_at!: Date

  // Relations
  @ManyToOne(() => Company)
  @JoinColumn({ name: "company_id" })
  company!: Company

  @ManyToOne(() => Product)
  @JoinColumn({ name: "product_id" })
  product!: Product
}
